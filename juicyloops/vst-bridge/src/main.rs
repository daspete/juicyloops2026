//! `juicyloops-bridge`: the desktop half of the Juicy Loops VST bridge.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use vst_bridge::audio::AudioRegistry;
use vst_bridge::config::{self, Config};
use vst_bridge::engine::{Engine, MainHandle};
use vst_bridge::plugin::PluginFormat;
use vst_bridge::scan::{self, ScanMethod, ScanSettings, Scanner};
use vst_bridge::server::{self, Shared};

struct Logger {
    level: log::LevelFilter,
    started: std::time::Instant,
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{:>8.3}] {:<5} {}", self.started.elapsed().as_secs_f64(), record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

fn init_logging() {
    let level = match std::env::var("JUICYLOOPS_BRIDGE_LOG").unwrap_or_default().to_ascii_lowercase().as_str() {
        "debug" => log::LevelFilter::Debug,
        "warn" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        "off" => log::LevelFilter::Off,
        _ => log::LevelFilter::Info,
    };
    let logger = Box::leak(Box::new(Logger { level, started: std::time::Instant::now() }));
    let _ = log::set_logger(logger);
    log::set_max_level(level);
}

fn main() {
    let options = match config::parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}\n\n{}", config::USAGE);
            std::process::exit(2);
        }
    };
    if options.help {
        print!("{}", config::USAGE);
        return;
    }
    if options.version {
        println!("juicyloops-bridge {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    // The child process of a scan: open one file, print what is in it, exit. A crash here is the point.
    if let Some((format, path)) = &options.scan_one {
        let format = match format.as_str() {
            "clap" => PluginFormat::Clap,
            "vst3" => PluginFormat::Vst3,
            _ => std::process::exit(2),
        };
        println!("{}", scan::scan_one_answer(format, path));
        // Some plugins misbehave on unload; the answer is out, so skip destructors.
        std::process::exit(0);
    }

    init_logging();
    let config_path = options.config_path.clone().unwrap_or_else(|| config::config_dir().join("config.json"));
    // A new token is made on the first start (no settings yet) and on --reset-token: the user has to pair (again).
    let new_token = options.reset_token || !config_path.exists();
    let mut config = match Config::load_or_create(&config_path) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("The settings in {} could not be read: {error}", config_path.display());
            std::process::exit(1);
        }
    };
    if options.reset_token {
        config.token = config::new_token();
        if let Err(error) = config.save(&config_path) {
            eprintln!("The new token could not be saved: {error}");
        }
    }
    if let Some(port) = options.port {
        config.port = port;
    }
    config.allowed_origins.extend(options.allow_origins.iter().cloned());
    config.extra_plugin_paths.extend(options.plugin_paths.iter().cloned());

    let listener = match server::bind(config.port) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "Could not listen on 127.0.0.1:{}: {error}\nIs the bridge running already? Otherwise start it with --port <another port> and set that port in the studio.",
                config.port
            );
            std::process::exit(1);
        }
    };
    let port = listener.local_addr().map(|address| address.port()).unwrap_or(config.port);

    #[cfg(feature = "gui")]
    let event_loop = if options.headless { None } else { vst_bridge::gui::event_loop() };
    #[cfg(feature = "gui")]
    let editors = event_loop.is_some();
    #[cfg(not(feature = "gui"))]
    let editors = false;

    #[cfg(feature = "gui")]
    let wake: Arc<dyn Fn() + Send + Sync> = match &event_loop {
        Some(event_loop) => {
            let proxy = event_loop.create_proxy();
            Arc::new(move || {
                let _ = proxy.send_event(());
            })
        }
        None => Arc::new(|| {}),
    };
    #[cfg(not(feature = "gui"))]
    let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(|| {});

    let (main, receiver) = MainHandle::new(wake);
    let audio = AudioRegistry::default();
    let mut engine = Engine::new(main.clone(), audio.clone());

    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("juicyloops-bridge"));
    let settings = ScanSettings {
        clap: config.scan_clap,
        vst3: config.scan_vst3,
        extra_paths: config.extra_plugin_paths.clone(),
        builtins: options.builtin_plugins,
        cache_file: Some(config::config_dir().join("plugins-cache.json")),
        method: ScanMethod::Subprocess { exe, timeout: Duration::from_secs(30) },
    };
    engine.set_plugins(scan::cached(&settings));
    let scanner = Scanner::new(settings);
    if !options.no_scan {
        scanner.rescan(main.clone());
    }

    println!("Juicy Loops Bridge {} is running.", env!("CARGO_PKG_VERSION"));
    println!("  Studio address:  ws://127.0.0.1:{port}");
    println!("  Pairing token:   {}", config.token);
    println!("  Status page:     http://127.0.0.1:{port}/");
    println!("  Settings:        {}", config_path.display());
    println!("  Plugin windows:  {}", if editors { "on" } else { "off (no display)" });
    println!("Leave this running while you use desktop plugins in the studio. Ctrl+C quits.");
    if new_token {
        show_status_page_without_terminal(port);
    }

    let shared = Shared { config: Arc::new(config), main: main.clone(), audio, scanner, editors_available: editors, port };
    std::thread::Builder::new().name("bridge-server".into()).spawn(move || server::serve(listener, shared)).expect("could not start the server thread");

    #[cfg(feature = "gui")]
    if let Some(event_loop) = event_loop {
        vst_bridge::gui::run(event_loop, engine, receiver);
        return;
    }
    vst_bridge::engine::run_headless(&mut engine, &receiver);
}

/// The Mac app started from Finder or the Dock has no terminal to print the pairing token to. When there is one to
/// pair with, it shows the status page (which has the token) in the default browser instead.
#[cfg(target_os = "macos")]
fn show_status_page_without_terminal(port: u16) {
    // SAFETY: isatty only looks at the descriptor.
    if unsafe { libc::isatty(libc::STDOUT_FILENO) } == 1 {
        return;
    }
    if let Err(error) = std::process::Command::new("/usr/bin/open").arg(format!("http://127.0.0.1:{port}/")).spawn() {
        log::warn!("Could not open the status page: {error}");
    }
}

/// Elsewhere the bridge runs in a terminal (Windows starts it in a console window), which shows the token.
#[cfg(not(target_os = "macos"))]
fn show_status_page_without_terminal(_port: u16) {}
