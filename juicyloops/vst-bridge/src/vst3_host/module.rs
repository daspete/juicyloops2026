//! Loading a VST3 bundle: find its binary for this OS, call its entry function, get its plugin factory. Modules
//! stay loaded until the bridge quits (unloading a plugin library while anything of it lives is a classic crash).

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use vst3::ComPtr;
use vst3::Steinberg::IPluginFactory;

pub struct Module {
    pub factory: ComPtr<IPluginFactory>,
    /// Kept so the library stays mapped.
    _library: libloading::Library,
}

thread_local! {
    /// Loaded modules by bundle path. Main-thread only, like everything that touches a factory.
    static MODULES: RefCell<HashMap<PathBuf, Rc<Module>>> = RefCell::new(HashMap::new());
}

/// The binary inside a bundle (or the file itself: Windows allows a lone `.vst3` DLL).
pub fn binary_path(bundle: &Path) -> Option<PathBuf> {
    if bundle.is_file() {
        return Some(bundle.to_path_buf());
    }
    let stem = bundle.file_stem()?.to_string_lossy().into_owned();
    let contents = bundle.join("Contents");
    #[cfg(target_os = "linux")]
    let (folders, extension): (Vec<String>, &str) = (vec![format!("{}-linux", std::env::consts::ARCH)], "so");
    #[cfg(target_os = "windows")]
    let (folders, extension): (Vec<String>, &str) = (vec![if cfg!(target_arch = "aarch64") { "arm64-win".into() } else { "x86_64-win".into() }], "vst3");
    #[cfg(target_os = "macos")]
    let (folders, extension): (Vec<String>, &str) = (vec!["MacOS".into()], "");
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    let (folders, extension): (Vec<String>, &str) = (vec![], "so");
    for folder in folders {
        let dir = contents.join(folder);
        let named = if extension.is_empty() { dir.join(&stem) } else { dir.join(format!("{stem}.{extension}")) };
        if named.is_file() {
            return Some(named);
        }
        // Some bundles are renamed after building: take the only binary there.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let mut binaries: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_file() && (extension.is_empty() || path.extension().is_some_and(|found| found == extension)))
                .collect();
            if binaries.len() == 1 {
                return binaries.pop();
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(allocator: *const c_void, buffer: *const u8, length: isize, is_directory: u8) -> *const c_void;
        fn CFBundleCreate(allocator: *const c_void, url: *const c_void) -> *mut c_void;
        fn CFRelease(object: *const c_void);
    }

    /// A CFBundle for the bundle folder (what `bundleEntry` wants). Leaked on purpose: modules stay loaded.
    pub fn bundle_ref(path: &std::path::Path) -> *mut c_void {
        use std::os::unix::ffi::OsStrExt;
        let bytes = path.as_os_str().as_bytes();
        // SAFETY: plain CoreFoundation calls with a valid buffer.
        unsafe {
            let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, 1);
            if url.is_null() {
                return std::ptr::null_mut();
            }
            let bundle = CFBundleCreate(std::ptr::null(), url);
            CFRelease(url);
            bundle
        }
    }
}

fn load(bundle: &Path) -> Result<Module, String> {
    let binary = binary_path(bundle).ok_or("no binary for this computer in the bundle")?;
    // SAFETY: loading a plugin runs its code; that is what a plugin host does. Scans do it in a child process.
    unsafe {
        #[cfg(unix)]
        let library: libloading::Library = {
            let library = libloading::os::unix::Library::open(Some(&binary), libc::RTLD_NOW | libc::RTLD_LOCAL).map_err(|error| error.to_string())?;
            #[cfg(target_os = "linux")]
            {
                let handle = library.into_raw();
                let library = libloading::os::unix::Library::from_raw(handle);
                if let Ok(entry) = library.get::<unsafe extern "C" fn(*mut std::ffi::c_void) -> bool>(b"ModuleEntry\0") {
                    if !entry(handle) {
                        return Err("the plugin refused to start (ModuleEntry)".into());
                    }
                }
                library.into()
            }
            #[cfg(target_os = "macos")]
            {
                if let Ok(entry) = library.get::<unsafe extern "C" fn(*mut std::ffi::c_void) -> bool>(b"bundleEntry\0") {
                    let bundle_ref = mac::bundle_ref(bundle);
                    if !entry(bundle_ref) {
                        return Err("the plugin refused to start (bundleEntry)".into());
                    }
                }
                library.into()
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                library.into()
            }
        };
        #[cfg(windows)]
        let library: libloading::Library = {
            let library = libloading::Library::new(&binary).map_err(|error| error.to_string())?;
            if let Ok(entry) = library.get::<unsafe extern "system" fn() -> bool>(b"InitDll\0") {
                if !entry() {
                    return Err("the plugin refused to start (InitDll)".into());
                }
            }
            library
        };
        let get_factory = library
            .get::<unsafe extern "system" fn() -> *mut IPluginFactory>(b"GetPluginFactory\0")
            .map_err(|_| "not a VST3 plugin (no GetPluginFactory)".to_string())?;
        let factory = ComPtr::from_raw(get_factory()).ok_or("the plugin has no factory")?;
        Ok(Module { factory, _library: library })
    }
}

/// The module of a bundle, loaded once.
pub fn module(bundle: &Path) -> Result<Rc<Module>, String> {
    if let Some(module) = MODULES.with(|modules| modules.borrow().get(bundle).cloned()) {
        return Ok(module);
    }
    let module = Rc::new(load(bundle)?);
    MODULES.with(|modules| modules.borrow_mut().insert(bundle.to_path_buf(), module.clone()));
    Ok(module)
}
