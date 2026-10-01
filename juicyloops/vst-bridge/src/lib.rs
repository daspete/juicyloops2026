//! Juicy Loops VST bridge: hosts desktop plugins (CLAP, VST3) and plays them for the studio in the browser over a
//! local WebSocket. See `README.md` and `PROTOCOL.md`.

pub mod audio;
pub mod builtin;
pub mod clap_host;
pub mod config;
pub mod engine;
pub mod error;
#[cfg(feature = "gui")]
pub mod gui;
pub mod plugin;
pub mod protocol;
pub mod scan;
pub mod server;
pub mod vst3_host;
