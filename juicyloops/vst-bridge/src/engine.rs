//! The main thread: it owns every plugin instance (plugins insist that most calls come from one thread), the
//! plugin list and the editor windows. Other threads hand it jobs through a `MainHandle` and wait for the answer.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use crossbeam_channel::{Receiver, Sender};
use raw_window_handle::RawWindowHandle;
use serde_json::json;

use crate::audio::{AudioRegistry, AudioSlot};
use crate::error::BridgeError;
use crate::plugin::{EditorMode, Notifier, Plugin, PluginDescription, PluginFormat, PluginNotice, ProcessSetup, Transport};
use crate::protocol::{InstanceMode, ServerEvent};
use crate::{builtin, clap_host, vst3_host};

/// A job for the main thread.
pub type Job = Box<dyn FnOnce(&mut Engine, &mut dyn Windows) + Send>;

pub enum MainMessage {
    Job(Job),
    Notice(u32, PluginNotice),
    /// The user closed an editor window.
    WindowClosed(u32),
    Quit,
}

/// How other threads reach the main thread.
#[derive(Clone)]
pub struct MainHandle {
    sender: Sender<MainMessage>,
    /// Wakes the main loop (a winit event loop sleeps until woken).
    wake: Arc<dyn Fn() + Send + Sync>,
}

/// How long a caller waits for the main thread (a plugin loading its samples can take a while).
const JOB_TIMEOUT: Duration = Duration::from_secs(60);

impl MainHandle {
    pub fn new(wake: Arc<dyn Fn() + Send + Sync>) -> (MainHandle, Receiver<MainMessage>) {
        let (sender, receiver) = crossbeam_channel::unbounded();
        (MainHandle { sender, wake }, receiver)
    }

    pub fn send(&self, message: MainMessage) {
        if self.sender.send(message).is_ok() {
            (self.wake)();
        }
    }

    /// Runs `job` on the main thread and waits for its result.
    pub fn run<R: Send + 'static>(&self, job: impl FnOnce(&mut Engine, &mut dyn Windows) -> R + Send + 'static) -> Result<R, BridgeError> {
        let (reply, answer) = crossbeam_channel::bounded(1);
        self.send(MainMessage::Job(Box::new(move |engine, windows| {
            let _ = reply.send(job(engine, windows));
        })));
        answer.recv_timeout(JOB_TIMEOUT).map_err(|_| BridgeError::internal("The bridge's main thread did not answer."))
    }

    pub fn notifier(&self, instance: u32) -> Notifier {
        let handle = self.clone();
        Arc::new(move |notice| handle.send(MainMessage::Notice(instance, notice)))
    }
}

/// Editor windows: made by the GUI event loop, or not at all when headless.
pub trait Windows {
    fn available(&self) -> bool;
    /// Makes a window for `instance`'s editor and returns its native handle.
    fn open(&mut self, instance: u32, title: &str, width: u32, height: u32, resizable: bool) -> Result<RawWindowHandle, BridgeError>;
    fn resize(&mut self, instance: u32, width: u32, height: u32);
    fn close(&mut self, instance: u32);
}

pub struct NoWindows;

impl Windows for NoWindows {
    fn available(&self) -> bool {
        false
    }

    fn open(&mut self, _: u32, _: &str, _: u32, _: u32, _: bool) -> Result<RawWindowHandle, BridgeError> {
        Err(BridgeError::unsupported("The bridge runs without a display, so it cannot show plugin windows."))
    }

    fn resize(&mut self, _: u32, _: u32, _: u32) {}

    fn close(&mut self, _: u32) {}
}

/// Who asked for an instance: a control connection. Its instances go when it does.
pub type Owner = u64;

struct Instance {
    plugin: Box<dyn Plugin>,
    owner: Owner,
    mode: InstanceMode,
    editor: Option<EditorMode>,
}

/// What the studio learns about a new instance.
#[derive(Clone, Debug, PartialEq)]
pub struct Created {
    pub instance: u32,
    pub description: PluginDescription,
    pub latency: u32,
    pub has_editor: bool,
    pub setup: ProcessSetup,
}

impl Created {
    pub fn to_json(&self) -> serde_json::Value {
        json!({
            "instance": self.instance,
            "plugin": self.description,
            "latency": self.latency,
            "hasEditor": self.has_editor,
            "inputChannels": self.setup.inputs,
            "outputChannels": self.setup.outputs,
            "maxBlock": self.setup.max_block,
        })
    }
}

pub struct Engine {
    plugins: Vec<PluginDescription>,
    scanning: bool,
    instances: HashMap<u32, Instance>,
    next_instance: u32,
    pub audio: AudioRegistry,
    main: MainHandle,
    /// Where each control connection gets its events.
    subscribers: HashMap<Owner, Sender<String>>,
}

impl Engine {
    pub fn new(main: MainHandle, audio: AudioRegistry) -> Self {
        Self { plugins: Vec::new(), scanning: false, instances: HashMap::new(), next_instance: 1, audio, main, subscribers: HashMap::new() }
    }

    pub fn main_handle(&self) -> &MainHandle {
        &self.main
    }

    /* ---- plugin list ---- */

    pub fn set_plugins(&mut self, plugins: Vec<PluginDescription>) {
        self.plugins = plugins;
        self.broadcast(&ServerEvent::PluginsChanged);
    }

    pub fn set_scanning(&mut self, scanning: bool) {
        self.scanning = scanning;
    }

    pub fn plugins(&self) -> &[PluginDescription] {
        &self.plugins
    }

    pub fn plugin_list_json(&self) -> serde_json::Value {
        json!({ "plugins": self.plugins, "scanning": self.scanning })
    }

    /* ---- events ---- */

    pub fn subscribe(&mut self, owner: Owner, sender: Sender<String>) {
        self.subscribers.insert(owner, sender);
    }

    /// A connection went away: its instances go too.
    pub fn unsubscribe(&mut self, owner: Owner, windows: &mut dyn Windows) {
        self.subscribers.remove(&owner);
        let owned: Vec<u32> = self.instances.iter().filter(|(_, instance)| instance.owner == owner).map(|(id, _)| *id).collect();
        for id in owned {
            let _ = self.destroy(id, windows);
        }
    }

    fn broadcast(&self, event: &ServerEvent) {
        let text = event.to_json();
        for sender in self.subscribers.values() {
            let _ = sender.send(text.clone());
        }
    }

    fn tell_owner(&self, instance: u32, event: &ServerEvent) {
        if let Some(sender) = self.instances.get(&instance).and_then(|instance| self.subscribers.get(&instance.owner)) {
            let _ = sender.send(event.to_json());
        }
    }

    /* ---- instances ---- */

    fn instantiate(&self, description: &PluginDescription, notifier: Notifier) -> Result<Box<dyn Plugin>, BridgeError> {
        match description.format {
            PluginFormat::Builtin => builtin::instantiate(&description.id),
            PluginFormat::Clap => clap_host::instantiate(description, notifier),
            PluginFormat::Vst3 => vst3_host::instantiate(description, notifier),
        }
    }

    pub fn create(&mut self, owner: Owner, plugin_id: &str, setup: ProcessSetup, state: Option<&[u8]>, mode: InstanceMode) -> Result<Created, BridgeError> {
        if !(8_000.0..=384_000.0).contains(&setup.sample_rate)
            || setup.max_block == 0
            || setup.max_block > 16_384
            || setup.inputs > 2
            || setup.outputs == 0
            || setup.outputs > 2
        {
            return Err(BridgeError::bad_request("Unsupported sample rate, block size or channel count."));
        }
        let description = self
            .plugins
            .iter()
            .find(|plugin| plugin.id == plugin_id)
            .cloned()
            .ok_or_else(|| BridgeError::not_found(format!("The plugin {plugin_id} is not installed on this computer (or the bridge has not found it).")))?;
        let id = self.next_instance;
        self.next_instance += 1;
        let mut plugin = self.instantiate(&description, self.main.notifier(id))?;
        if let Some(state) = state {
            if !state.is_empty() {
                plugin.load_state(state)?;
            }
        }
        let setup = ProcessSetup { offline: mode == InstanceMode::Offline, ..setup };
        let processor = plugin.activate(setup)?;
        let latency = plugin.latency();
        let editor = plugin.editor_mode();
        self.audio.insert(id, AudioSlot::new(processor, setup));
        self.instances.insert(id, Instance { plugin, owner, mode, editor: None });
        log::info!("instance {id}: {} ({:?}, {} Hz, blocks of {})", description.name, mode, setup.sample_rate, setup.max_block);
        Ok(Created { instance: id, description, latency, has_editor: editor.is_some(), setup })
    }

    fn instance(&mut self, id: u32) -> Result<&mut Instance, BridgeError> {
        self.instances.get_mut(&id).ok_or_else(|| BridgeError::not_found(format!("No instance {id}.")))
    }

    pub fn destroy(&mut self, id: u32, windows: &mut dyn Windows) -> Result<(), BridgeError> {
        if self.instances.get(&id).is_some_and(|instance| instance.editor.is_some()) {
            self.close_editor(id, windows)?;
        }
        let mut instance = self.instances.remove(&id).ok_or_else(|| BridgeError::not_found(format!("No instance {id}.")))?;
        if let Some(slot) = self.audio.remove(id) {
            // Waits for a block in progress to finish.
            let processor = slot.lock().unwrap_or_else(|poison| poison.into_inner()).take_processor();
            if let Some(processor) = processor {
                instance.plugin.deactivate(processor);
            }
        }
        log::info!("instance {id} closed");
        drop(instance);
        Ok(())
    }

    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    pub fn instance_mode(&self, id: u32) -> Option<InstanceMode> {
        self.instances.get(&id).map(|instance| instance.mode)
    }

    pub fn get_state(&mut self, id: u32) -> Result<String, BridgeError> {
        let chunk = self.instance(id)?.plugin.save_state()?;
        Ok(BASE64.encode(chunk))
    }

    pub fn set_state(&mut self, id: u32, state: &str) -> Result<(), BridgeError> {
        let chunk = BASE64.decode(state.trim()).map_err(|_| BridgeError::bad_request("The state is not base64."))?;
        self.instance(id)?.plugin.load_state(&chunk)
    }

    pub fn params(&mut self, id: u32) -> Result<serde_json::Value, BridgeError> {
        Ok(json!({ "params": self.instance(id)?.plugin.params() }))
    }

    pub fn set_param(&mut self, id: u32, param: u32, value: f64) -> Result<(), BridgeError> {
        self.instance(id)?.plugin.set_param(param, value)
    }

    pub fn set_transport(&mut self, owner: Owner, id: Option<u32>, transport: Transport) -> Result<(), BridgeError> {
        let ids: Vec<u32> = match id {
            Some(id) => vec![id],
            // The studio's own transport: live instances only (an export sets its instances one by one).
            None => self.instances.iter().filter(|(_, instance)| instance.owner == owner && instance.mode == InstanceMode::Live).map(|(id, _)| *id).collect(),
        };
        for id in ids {
            if let Some(slot) = self.audio.get(id) {
                slot.lock().unwrap_or_else(|poison| poison.into_inner()).transport = transport;
            }
        }
        Ok(())
    }

    pub fn reset(&mut self, id: u32) -> Result<(), BridgeError> {
        self.instance(id)?;
        if let Some(slot) = self.audio.get(id) {
            slot.lock().unwrap_or_else(|poison| poison.into_inner()).reset();
        }
        Ok(())
    }

    /* ---- editors ---- */

    pub fn open_editor(&mut self, id: u32, title: Option<&str>, windows: &mut dyn Windows) -> Result<(), BridgeError> {
        let instance = self.instances.get_mut(&id).ok_or_else(|| BridgeError::not_found(format!("No instance {id}.")))?;
        if instance.editor.is_some() {
            // Already open: nothing to do (the window may be behind others; a floating one we cannot raise).
            return Ok(());
        }
        let mode = instance.plugin.editor_mode().ok_or_else(|| BridgeError::unsupported("This plugin has no window of its own."))?;
        let title = title.map(str::to_string).unwrap_or_else(|| instance.plugin.description().name.clone());
        match mode {
            EditorMode::Floating => {
                // SAFETY: no parent window is involved.
                unsafe { instance.plugin.open_editor(None, &title)? };
            }
            EditorMode::Embedded => {
                if !windows.available() {
                    return Err(BridgeError::unsupported("The bridge runs without a display, so it cannot show plugin windows."));
                }
                // The editor's size is known only once it exists, so the window starts at a guess and follows.
                let resizable = instance.plugin.editor_resizable();
                let parent = windows.open(id, &title, 640, 480, resizable)?;
                // SAFETY: the window lives until `close_editor`, which closes the editor first.
                match unsafe { instance.plugin.open_editor(Some(parent), &title) } {
                    Ok(Some((width, height))) => windows.resize(id, width, height),
                    Ok(None) => {}
                    Err(error) => {
                        windows.close(id);
                        return Err(error);
                    }
                }
            }
        }
        instance.editor = Some(mode);
        Ok(())
    }

    pub fn close_editor(&mut self, id: u32, windows: &mut dyn Windows) -> Result<(), BridgeError> {
        let instance = self.instance(id)?;
        if let Some(mode) = instance.editor.take() {
            instance.plugin.close_editor();
            if mode == EditorMode::Embedded {
                windows.close(id);
            }
        }
        Ok(())
    }

    /// The user closed an editor's window on the desktop.
    pub fn window_closed(&mut self, id: u32, windows: &mut dyn Windows) {
        if self.close_editor(id, windows).is_ok() {
            self.tell_owner(id, &ServerEvent::EditorClosed { instance: id });
            // Closing a window is when people expect their tweaks to be kept.
            self.tell_owner(id, &ServerEvent::StateChanged { instance: id });
        }
    }

    /// The window around an embedded editor was resized by the user.
    pub fn window_resized(&mut self, id: u32, width: u32, height: u32, scale: f64, windows: &mut dyn Windows) {
        if let Some(instance) = self.instances.get_mut(&id) {
            if let Some((settled_width, settled_height)) = instance.plugin.resize_editor(width, height, scale) {
                if (settled_width, settled_height) != (width, height) {
                    windows.resize(id, settled_width, settled_height);
                }
            }
        }
    }

    pub fn notice(&mut self, id: u32, notice: PluginNotice, windows: &mut dyn Windows) {
        match notice {
            PluginNotice::MainThreadCallback => {
                if let Some(instance) = self.instances.get_mut(&id) {
                    instance.plugin.idle();
                }
            }
            PluginNotice::EditorClosed => {
                if let Some(instance) = self.instances.get_mut(&id) {
                    instance.editor = None;
                    instance.plugin.close_editor();
                }
                self.tell_owner(id, &ServerEvent::EditorClosed { instance: id });
                self.tell_owner(id, &ServerEvent::StateChanged { instance: id });
            }
            PluginNotice::EditorResize { width, height } => {
                if self.instances.get(&id).is_some_and(|instance| instance.editor == Some(EditorMode::Embedded)) {
                    windows.resize(id, width, height);
                }
            }
            PluginNotice::StateDirty => self.tell_owner(id, &ServerEvent::StateChanged { instance: id }),
            PluginNotice::LatencyChanged => {
                if let Some(instance) = self.instances.get_mut(&id) {
                    let latency = instance.plugin.latency();
                    self.tell_owner(id, &ServerEvent::LatencyChanged { instance: id, latency });
                }
            }
            PluginNotice::RestartRequested => {
                if let Err(error) = self.restart(id) {
                    log::warn!("instance {id} could not restart: {error}");
                }
            }
        }
    }

    /// Deactivates and activates again (a plugin asks for it after its I/O or latency changed).
    fn restart(&mut self, id: u32) -> Result<(), BridgeError> {
        let slot = self.audio.get(id).ok_or_else(|| BridgeError::not_found(format!("No instance {id}.")))?;
        let instance = self.instances.get_mut(&id).ok_or_else(|| BridgeError::not_found(format!("No instance {id}.")))?;
        let mut slot = slot.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(processor) = slot.take_processor() {
            instance.plugin.deactivate(processor);
        }
        let processor = instance.plugin.activate(slot.setup)?;
        slot.put_processor(processor);
        Ok(())
    }

    /// Main-thread chores of every plugin (timers, deferred callbacks). Called every few milliseconds.
    pub fn idle(&mut self) {
        for instance in self.instances.values_mut() {
            instance.plugin.idle();
        }
    }

    /// Closes everything (on quit).
    pub fn shutdown(&mut self, windows: &mut dyn Windows) {
        let ids: Vec<u32> = self.instances.keys().copied().collect();
        for id in ids {
            let _ = self.destroy(id, windows);
        }
    }

    pub fn handle(&mut self, message: MainMessage, windows: &mut dyn Windows) -> bool {
        match message {
            MainMessage::Job(job) => job(self, windows),
            MainMessage::Notice(id, notice) => self.notice(id, notice, windows),
            MainMessage::WindowClosed(id) => self.window_closed(id, windows),
            MainMessage::Quit => return false,
        }
        true
    }
}

/// The main loop without a display: jobs and notices, and plugin chores every 10 ms.
pub fn run_headless(engine: &mut Engine, receiver: &Receiver<MainMessage>) {
    let mut windows = NoWindows;
    loop {
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(message) => {
                if !engine.handle(message, &mut windows) {
                    break;
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }
        engine.idle();
    }
    engine.shutdown(&mut windows);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        let (main, _receiver) = MainHandle::new(Arc::new(|| {}));
        let mut engine = Engine::new(main, AudioRegistry::default());
        engine.set_plugins(builtin::descriptions());
        engine
    }

    const SETUP: ProcessSetup = ProcessSetup { sample_rate: 48_000.0, max_block: 256, inputs: 0, outputs: 2, offline: false };

    #[test]
    fn instances_come_and_go_with_their_connection() {
        let mut engine = engine();
        let mut windows = NoWindows;
        let a = engine.create(1, builtin::SYNTH_ID, SETUP, None, InstanceMode::Live).unwrap();
        let b = engine.create(2, builtin::GAIN_ID, ProcessSetup { inputs: 2, ..SETUP }, None, InstanceMode::Live).unwrap();
        assert!(engine.audio.get(a.instance).is_some());
        engine.unsubscribe(1, &mut windows);
        assert!(engine.audio.get(a.instance).is_none());
        assert!(engine.audio.get(b.instance).is_some());
        assert_eq!(engine.instance_count(), 1);
    }

    #[test]
    fn state_travels_as_base64() {
        let mut engine = engine();
        let a = engine.create(1, builtin::GAIN_ID, SETUP, None, InstanceMode::Live).unwrap();
        engine.set_param(a.instance, 0, 0.75).unwrap();
        let state = engine.get_state(a.instance).unwrap();
        let chunk = BASE64.decode(&state).unwrap();
        let b = engine.create(1, builtin::GAIN_ID, SETUP, Some(&chunk), InstanceMode::Offline).unwrap();
        assert_eq!(engine.params(b.instance).unwrap()["params"][0]["value"], 0.75);
        assert!(engine.set_state(b.instance, "not base64!").is_err());
    }

    #[test]
    fn unknown_plugins_and_bad_setups_are_refused() {
        let mut engine = engine();
        assert_eq!(engine.create(1, "clap:nope", SETUP, None, InstanceMode::Live).unwrap_err().code, "not-found");
        assert_eq!(engine.create(1, builtin::SYNTH_ID, ProcessSetup { sample_rate: 1.0, ..SETUP }, None, InstanceMode::Live).unwrap_err().code, "bad-request");
        assert_eq!(engine.create(1, builtin::SYNTH_ID, ProcessSetup { outputs: 6, ..SETUP }, None, InstanceMode::Live).unwrap_err().code, "bad-request");
    }

    #[test]
    fn editors_need_a_display() {
        let mut engine = engine();
        let a = engine.create(1, builtin::SYNTH_ID, SETUP, None, InstanceMode::Live).unwrap();
        assert!(!a.has_editor);
        assert_eq!(engine.open_editor(a.instance, None, &mut NoWindows).unwrap_err().code, "unsupported");
    }
}
