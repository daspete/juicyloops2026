//! Windows builds get the Juicy Loops icon and version info compiled into `juicyloops-bridge.exe`
//! (`assets/windows.rc`, `assets/icon.ico`; MinGW's `windres` when cross-compiling, `rc.exe` with MSVC). Other systems
//! carry the icon outside the binary: an app bundle on macOS, a desktop entry on Linux.

fn main() {
    println!("cargo:rerun-if-changed=assets/windows.rc");
    println!("cargo:rerun-if-changed=assets/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let version = std::env::var("CARGO_PKG_VERSION").expect("cargo sets the package version");
    let mut parts = version.split(['.', '-']).map(|part| part.parse::<u16>().unwrap_or(0));
    let [major, minor, patch] = [parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0)];
    let macros = [
        format!("VERSION_NUMBERS={major},{minor},{patch},0"),
        // Unquoted: quotes do not survive the way windres passes defines on; windows.rc turns it into a string.
        format!("VERSION_TEXT={version}"),
    ];
    embed_resource::compile("assets/windows.rc", macros.iter()).manifest_optional().expect("the Windows resources compile");
}
