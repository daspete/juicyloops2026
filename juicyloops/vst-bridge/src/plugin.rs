//! The format-independent plugin model: what the bridge knows about a plugin on disk (`PluginDescription`), a
//! running instance on the main thread (`Plugin`), and its audio half on the audio thread (`Processor`).
//!
//! Every plugin format (CLAP, VST3, the built-in test plugins) implements these two traits; the engine, the
//! server and the render mode only ever see the traits.

use std::any::Any;
use std::path::PathBuf;
use std::sync::Arc;

use raw_window_handle::RawWindowHandle;
use serde::{Deserialize, Serialize};

use crate::error::BridgeError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginFormat {
    Clap,
    Vst3,
    /// The bridge's own test plugins (only listed with `--builtin-plugins`).
    Builtin,
}

impl PluginFormat {
    pub fn prefix(self) -> &'static str {
        match self {
            PluginFormat::Clap => "clap",
            PluginFormat::Vst3 => "vst3",
            PluginFormat::Builtin => "builtin",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Instrument,
    Effect,
}

/// A plugin found on disk.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescription {
    /// The bridge's id: `<format>:<native id>` (`clap:com.u-he.diva`, `vst3:<class id in hex>`, `builtin:sine`).
    pub id: String,
    pub format: PluginFormat,
    /// The plugin's own id inside its file (a CLAP id, a VST3 class id in hex).
    pub native_id: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub kind: PluginKind,
    /// Finer categories as the plugin names them (`Synth`, `Delay`, ...).
    pub categories: Vec<String>,
    /// The bundle or library it was found in (empty for built-ins).
    pub path: PathBuf,
}

/// How an instance processes: fixed when it is activated.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProcessSetup {
    pub sample_rate: f64,
    /// The most frames one `process` call gets.
    pub max_block: u32,
    /// Channels of audio in (0 for an instrument, 2 for an effect).
    pub inputs: u32,
    /// Channels of audio out (2).
    pub outputs: u32,
    /// Rendering an export (as fast as possible) rather than playing live. VST3 plugins may pick better quality.
    pub offline: bool,
}

/// A MIDI 1.0 channel message at a frame of the block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MidiEvent {
    pub frame: u32,
    pub bytes: [u8; 3],
}

impl MidiEvent {
    pub fn new(frame: u32, bytes: [u8; 3]) -> Self {
        Self { frame, bytes }
    }

    pub fn status(&self) -> u8 {
        self.bytes[0] & 0xf0
    }

    pub fn channel(&self) -> u8 {
        self.bytes[0] & 0x0f
    }

    /// A note-on with velocity 0 is a note-off.
    pub fn is_note_on(&self) -> bool {
        self.status() == 0x90 && self.bytes[2] > 0
    }

    pub fn is_note_off(&self) -> bool {
        self.status() == 0x80 || (self.status() == 0x90 && self.bytes[2] == 0)
    }
}

/// Tempo and play state, as far as the studio shares them with the bridge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transport {
    pub bpm: f64,
    pub playing: bool,
}

impl Default for Transport {
    fn default() -> Self {
        Self { bpm: 120.0, playing: false }
    }
}

/// A parameter as the plugin describes it. Values are plain (the plugin's own range) for CLAP and normalized
/// (0..1) for VST3; `min`/`max` say which.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamInfo {
    pub id: u32,
    pub name: String,
    pub module: String,
    pub min: f64,
    pub max: f64,
    pub default: f64,
    pub value: f64,
    pub automatable: bool,
}

/// How a plugin shows its editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditorMode {
    /// Into a window the bridge makes (the common case).
    Embedded,
    /// In a window the plugin makes itself.
    Floating,
}

/// What a plugin tells the bridge from any thread; delivered to the main thread.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PluginNotice {
    /// The plugin asks for `Plugin::on_main_thread`.
    MainThreadCallback,
    /// Its floating editor window was closed by the user.
    EditorClosed,
    /// It wants its editor window resized (in the size units of its editor API).
    EditorResize { width: u32, height: u32 },
    /// Its state changed (a knob turned in its window): the studio should read it again.
    StateDirty,
    /// Its latency changed.
    LatencyChanged,
    /// It asks to be restarted (deactivated and activated again).
    RestartRequested,
}

/// How a plugin reaches the main thread. Cheap to clone; callable from any thread (never blocks).
pub type Notifier = Arc<dyn Fn(PluginNotice) + Send + Sync>;

/// A plugin instance, owned by the main thread. Everything here is a main-thread call in CLAP and VST3 terms.
pub trait Plugin {
    fn description(&self) -> &PluginDescription;

    /// Prepares processing and hands out the audio half. At most one processor is out at a time.
    fn activate(&mut self, setup: ProcessSetup) -> Result<Box<dyn Processor>, BridgeError>;

    /// Takes the audio half back (it must be the one `activate` gave out).
    fn deactivate(&mut self, processor: Box<dyn Processor>);

    /// The plugin's whole state as an opaque chunk (what a DAW saves in its project).
    fn save_state(&mut self) -> Result<Vec<u8>, BridgeError>;

    fn load_state(&mut self, chunk: &[u8]) -> Result<(), BridgeError>;

    fn params(&mut self) -> Vec<ParamInfo>;

    /// Sets a parameter from the main thread (applied at the next block).
    fn set_param(&mut self, id: u32, value: f64) -> Result<(), BridgeError>;

    /// Frames of latency the plugin adds.
    fn latency(&mut self) -> u32 {
        0
    }

    /// Answers `PluginNotice::MainThreadCallback`, runs timers and other main-thread chores. Called often.
    fn idle(&mut self) {}

    /// How the editor opens, or `None` when there is none.
    fn editor_mode(&mut self) -> Option<EditorMode> {
        None
    }

    /// Creates the editor. Embedded editors get the window to live in and return their size; floating ones get
    /// no parent and show themselves.
    ///
    /// # Safety
    /// `parent` must stay a valid window until `close_editor` returns.
    unsafe fn open_editor(&mut self, _parent: Option<RawWindowHandle>, _title: &str) -> Result<Option<(u32, u32)>, BridgeError> {
        Err(BridgeError::unsupported("This plugin has no editor."))
    }

    /// The window was resized to `width`×`height` (physical pixels, `scale` for logical APIs); returns the size the
    /// editor settled on.
    fn resize_editor(&mut self, width: u32, height: u32, _scale: f64) -> Option<(u32, u32)> {
        Some((width, height))
    }

    /// Whether the embedded editor window may be resized by the user.
    fn editor_resizable(&mut self) -> bool {
        false
    }

    fn close_editor(&mut self) {}
}

/// Where a process call reads and writes. Channel slices are all `frames` long.
pub struct ProcessBuffers<'a, 'b> {
    pub inputs: &'a [&'b [f32]],
    pub outputs: &'a mut [&'b mut [f32]],
    pub frames: u32,
}

/// The audio half of an instance. Moves to whichever thread processes; never called concurrently.
pub trait Processor: Send {
    /// Renders one block. `events` are sorted by frame, all `< frames`. Must not allocate.
    fn process(&mut self, buffers: ProcessBuffers<'_, '_>, events: &[MidiEvent], transport: &Transport) -> Result<(), BridgeError>;

    /// Forgets voices and tails (a jump in time: a new render, a seek).
    fn reset(&mut self);

    /// For `Plugin::deactivate`, which needs its own concrete type back.
    fn into_any(self: Box<Self>) -> Box<dyn Any + Send>;
}
