//! Finding plugins: the standard CLAP and VST3 folders of each OS plus the user's own, a cache keyed by file and
//! modification time, and a crash-proof scan: each new file is opened in a child process (`--scan-one`), so a
//! plugin that crashes while loading takes only that process down.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::engine::MainHandle;
use crate::plugin::{PluginDescription, PluginFormat};
use crate::{builtin, clap_host, vst3_host};

/// The folders an OS keeps plugins of a format in, in the order hosts look.
pub fn standard_paths(format: PluginFormat) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let home = env("HOME");
    match format {
        PluginFormat::Clap => {
            // CLAP_PATH comes first, as the CLAP spec says.
            if let Some(list) = std::env::var_os("CLAP_PATH") {
                paths.extend(std::env::split_paths(&list));
            }
            #[cfg(target_os = "windows")]
            {
                if let Some(common) = env("COMMONPROGRAMFILES") {
                    paths.push(common.join("CLAP"));
                }
                if let Some(local) = env("LOCALAPPDATA") {
                    paths.push(local.join("Programs").join("Common").join("CLAP"));
                }
            }
            #[cfg(target_os = "macos")]
            {
                paths.push(PathBuf::from("/Library/Audio/Plug-Ins/CLAP"));
                if let Some(home) = &home {
                    paths.push(home.join("Library/Audio/Plug-Ins/CLAP"));
                }
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                if let Some(home) = &home {
                    paths.push(home.join(".clap"));
                }
                paths.push(PathBuf::from("/usr/lib/clap"));
                paths.push(PathBuf::from("/usr/local/lib/clap"));
            }
        }
        PluginFormat::Vst3 => {
            #[cfg(target_os = "windows")]
            {
                if let Some(common) = env("COMMONPROGRAMFILES") {
                    paths.push(common.join("VST3"));
                }
                if let Some(local) = env("LOCALAPPDATA") {
                    paths.push(local.join("Programs").join("Common").join("VST3"));
                }
            }
            #[cfg(target_os = "macos")]
            {
                paths.push(PathBuf::from("/Library/Audio/Plug-Ins/VST3"));
                if let Some(home) = &home {
                    paths.push(home.join("Library/Audio/Plug-Ins/VST3"));
                }
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                if let Some(home) = &home {
                    paths.push(home.join(".vst3"));
                }
                paths.push(PathBuf::from("/usr/lib/vst3"));
                paths.push(PathBuf::from("/usr/local/lib/vst3"));
            }
        }
        PluginFormat::Builtin => {}
    }
    let _ = home;
    paths
}

/// Plugin files (CLAP) and bundles (VST3) under `root`, not descending into a bundle once found.
pub fn find_candidates(root: &Path, format: PluginFormat) -> Vec<PathBuf> {
    let extension = match format {
        PluginFormat::Clap => "clap",
        PluginFormat::Vst3 => "vst3",
        PluginFormat::Builtin => return Vec::new(),
    };
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
        entries.sort();
        for path in entries {
            let is_match = path.extension().is_some_and(|found| found.eq_ignore_ascii_case(extension));
            if is_match {
                found.push(path);
            } else if path.is_dir() && depth < 8 {
                stack.push((path, depth + 1));
            }
        }
    }
    found
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    path: PathBuf,
    format: PluginFormat,
    modified: u64,
    plugins: Vec<PluginDescription>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    entries: Vec<CacheEntry>,
}

const CACHE_VERSION: u32 = 1;

fn modified_of(path: &Path) -> u64 {
    // A bundle's own folder time does not change when its binary is replaced; the newest of the folder and its
    // `Contents` is close enough without walking the whole bundle.
    let time = |path: &Path| {
        std::fs::metadata(path).and_then(|meta| meta.modified()).ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |time| time.as_secs())
    };
    time(path).max(time(&path.join("Contents")))
}

/// How one file is opened for its descriptions.
#[derive(Clone, Debug)]
pub enum ScanMethod {
    /// In this process (tests; the built-in plugins).
    InProcess,
    /// In a child process of this executable (`--scan-one`), killed after the timeout.
    Subprocess { exe: PathBuf, timeout: Duration },
}

/// Opens one file and lists its plugins (what `--scan-one` runs).
pub fn scan_file(format: PluginFormat, path: &Path) -> Result<Vec<PluginDescription>, String> {
    match format {
        PluginFormat::Clap => clap_host::scan_file(path),
        PluginFormat::Vst3 => vst3_host::scan_bundle(path),
        PluginFormat::Builtin => Ok(Vec::new()),
    }
}

fn scan_in_child(exe: &Path, timeout: Duration, format: PluginFormat, path: &Path) -> Result<Vec<PluginDescription>, String> {
    let mut child = Command::new(exe)
        .arg("--scan-one")
        .arg(format.prefix())
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start the scanner: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    use std::io::Read;
                    let _ = stdout.read_to_string(&mut output);
                }
                if !status.success() {
                    return Err(format!("the plugin crashed or failed while loading ({status})"));
                }
                let line = output.lines().rev().find(|line| line.starts_with('{') || line.starts_with('[')).unwrap_or("");
                #[derive(Deserialize)]
                struct Answer {
                    plugins: Option<Vec<PluginDescription>>,
                    error: Option<String>,
                }
                let answer: Answer = serde_json::from_str(line).map_err(|_| "the scanner gave no answer".to_string())?;
                return match (answer.plugins, answer.error) {
                    (Some(plugins), _) => Ok(plugins),
                    (None, error) => Err(error.unwrap_or_else(|| "unknown error".into())),
                };
            }
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the plugin took too long to load".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// What `--scan-one` prints.
pub fn scan_one_answer(format: PluginFormat, path: &Path) -> String {
    match scan_file(format, path) {
        Ok(plugins) => serde_json::json!({ "plugins": plugins }).to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

#[derive(Clone, Debug)]
pub struct ScanSettings {
    pub clap: bool,
    pub vst3: bool,
    pub extra_paths: Vec<PathBuf>,
    pub builtins: bool,
    pub cache_file: Option<PathBuf>,
    pub method: ScanMethod,
}

/// Scans every folder; files already in the cache with the same time are not opened again (unless `full`, which
/// retries the ones that failed).
pub fn scan(settings: &ScanSettings, full: bool) -> Vec<PluginDescription> {
    let cache: CacheFile = settings
        .cache_file
        .as_ref()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<CacheFile>(&text).ok())
        .filter(|cache| cache.version == CACHE_VERSION)
        .unwrap_or_default();
    let cached: HashMap<(PluginFormat, PathBuf), CacheEntry> = cache.entries.into_iter().map(|entry| ((entry.format, entry.path.clone()), entry)).collect();

    let mut entries = Vec::new();
    let mut formats = Vec::new();
    if settings.clap {
        formats.push(PluginFormat::Clap);
    }
    if settings.vst3 {
        formats.push(PluginFormat::Vst3);
    }
    for format in formats {
        let mut roots = standard_paths(format);
        roots.extend(settings.extra_paths.iter().cloned());
        let mut seen = std::collections::HashSet::new();
        for root in roots {
            for path in find_candidates(&root, format) {
                let canonical = std::fs::canonicalize(&path).unwrap_or(path.clone());
                if !seen.insert(canonical) {
                    continue;
                }
                let modified = modified_of(&path);
                if let Some(entry) = cached.get(&(format, path.clone())) {
                    if entry.modified == modified && !(full && entry.error.is_some()) {
                        entries.push(entry.clone());
                        continue;
                    }
                }
                let result = open(settings, format, &path);
                match &result {
                    Ok(plugins) => log::info!("scanned {}: {} plugin(s)", path.display(), plugins.len()),
                    Err(error) => log::warn!("could not scan {}: {error}", path.display()),
                }
                entries.push(CacheEntry { path, format, modified, plugins: result.clone().unwrap_or_default(), error: result.err() });
            }
        }
    }
    if let Some(file) = &settings.cache_file {
        let cache = CacheFile { version: CACHE_VERSION, entries: entries.clone() };
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(&cache) {
            let _ = std::fs::write(file, text);
        }
    }
    let mut plugins: Vec<PluginDescription> = entries.into_iter().flat_map(|entry| entry.plugins).collect();
    // One id once (the same plugin in two folders: the first folder wins, as in other hosts).
    let mut ids = std::collections::HashSet::new();
    plugins.retain(|plugin| ids.insert(plugin.id.clone()));
    plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.format.prefix().cmp(b.format.prefix())));
    if settings.builtins {
        plugins.extend(builtin::descriptions());
    }
    plugins
}

/// The cached list, without opening anything (what the bridge offers while the first scan runs).
pub fn cached(settings: &ScanSettings) -> Vec<PluginDescription> {
    let mut plugins: Vec<PluginDescription> = settings
        .cache_file
        .as_ref()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<CacheFile>(&text).ok())
        .filter(|cache| cache.version == CACHE_VERSION)
        .map(|cache| cache.entries.into_iter().filter(|entry| entry.path.exists()).flat_map(|entry| entry.plugins).collect())
        .unwrap_or_default();
    if settings.builtins {
        plugins.extend(builtin::descriptions());
    }
    plugins
}

fn open(settings: &ScanSettings, format: PluginFormat, path: &Path) -> Result<Vec<PluginDescription>, String> {
    match &settings.method {
        ScanMethod::InProcess => scan_file(format, path),
        ScanMethod::Subprocess { exe, timeout } => scan_in_child(exe, *timeout, format, path),
    }
}

/// Runs scans in the background, one at a time, and hands the result to the engine.
#[derive(Clone)]
pub struct Scanner {
    settings: Arc<ScanSettings>,
    busy: Arc<AtomicBool>,
    /// A rescan asked for while one runs: runs again after it.
    again: Arc<Mutex<bool>>,
}

impl Scanner {
    pub fn new(settings: ScanSettings) -> Self {
        Self { settings: Arc::new(settings), busy: Arc::new(AtomicBool::new(false)), again: Arc::new(Mutex::new(false)) }
    }

    pub fn settings(&self) -> &ScanSettings {
        &self.settings
    }

    pub fn rescan(&self, main: MainHandle) {
        if self.busy.swap(true, Ordering::SeqCst) {
            *self.again.lock().unwrap_or_else(|poison| poison.into_inner()) = true;
            return;
        }
        let scanner = self.clone();
        std::thread::Builder::new()
            .name("bridge-scan".into())
            .spawn(move || {
                loop {
                    let _ = main.run(|engine, _| engine.set_scanning(true));
                    let plugins = scan(&scanner.settings, true);
                    let _ = main.run(move |engine, _| {
                        engine.set_scanning(false);
                        engine.set_plugins(plugins);
                    });
                    let mut again = scanner.again.lock().unwrap_or_else(|poison| poison.into_inner());
                    if !*again {
                        scanner.busy.store(false, Ordering::SeqCst);
                        break;
                    }
                    *again = false;
                }
            })
            .expect("could not start the scan thread");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_are_found_without_descending_into_bundles() {
        let root = std::env::temp_dir().join(format!("jl-bridge-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Vendor/Synth.vst3/Contents/x86_64-linux")).unwrap();
        std::fs::write(root.join("Vendor/Synth.vst3/Contents/x86_64-linux/Synth.so"), b"").unwrap();
        std::fs::create_dir_all(root.join("Inner.vst3/Contents/Resources/Nested.vst3")).unwrap();
        std::fs::write(root.join("a.clap"), b"").unwrap();
        std::fs::write(root.join("notes.txt"), b"").unwrap();
        let vst3 = find_candidates(&root, PluginFormat::Vst3);
        assert_eq!(vst3, vec![root.join("Inner.vst3"), root.join("Vendor/Synth.vst3")]);
        assert_eq!(find_candidates(&root, PluginFormat::Clap), vec![root.join("a.clap")]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_standard_folders_are_the_documented_ones() {
        let clap = standard_paths(PluginFormat::Clap);
        let vst3 = standard_paths(PluginFormat::Vst3);
        #[cfg(target_os = "linux")]
        {
            assert!(clap.contains(&PathBuf::from("/usr/lib/clap")));
            assert!(vst3.contains(&PathBuf::from("/usr/lib/vst3")));
        }
        assert!(!clap.is_empty() && !vst3.is_empty());
    }

    #[test]
    fn a_broken_file_is_cached_as_failed_and_the_list_keeps_builtins() {
        let root = std::env::temp_dir().join(format!("jl-bridge-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        std::fs::write(root.join("plugins/broken.clap"), b"not a library").unwrap();
        let settings = ScanSettings {
            clap: true,
            vst3: false,
            extra_paths: vec![root.join("plugins")],
            builtins: true,
            cache_file: Some(root.join("cache.json")),
            method: ScanMethod::InProcess,
        };
        let plugins = scan(&settings, false);
        assert!(plugins.iter().all(|plugin| plugin.format == PluginFormat::Builtin || plugin.path != root.join("plugins/broken.clap")));
        assert_eq!(plugins.iter().filter(|plugin| plugin.format == PluginFormat::Builtin).count(), 2);
        let cache: CacheFile = serde_json::from_str(&std::fs::read_to_string(root.join("cache.json")).unwrap()).unwrap();
        let entry = cache.entries.iter().find(|entry| entry.path == root.join("plugins/broken.clap")).unwrap();
        assert!(entry.error.is_some());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
