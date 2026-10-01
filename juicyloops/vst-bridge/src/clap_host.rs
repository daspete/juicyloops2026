//! CLAP plugins, through Clack (`clack-host`, MIT/Apache-2.0). The GUI, timer, posix-fd, state, params, latency
//! and ports extensions are supported; notes go out as CLAP note events when the plugin takes them, else as MIDI.
//! Parts of the GUI negotiation follow Clack's own example host (`host/examples/cpal`, same licence).

use std::any::Any;
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::path::Path;
use std::time::{Duration, Instant};

use clack_extensions::audio_ports::{AudioPortInfoBuffer, AudioPortRescanFlags, HostAudioPorts, HostAudioPortsImpl, PluginAudioPorts};
use clack_extensions::gui::{GuiApiType, GuiConfiguration, GuiSize, HostGui, HostGuiImpl, PluginGui, Window as ClapWindow};
use clack_extensions::latency::{HostLatency, HostLatencyImpl, PluginLatency};
use clack_extensions::log::{HostLog, HostLogImpl, LogSeverity};
use clack_extensions::note_ports::{HostNotePorts, HostNotePortsImpl, NoteDialects, NotePortInfoBuffer, NotePortRescanFlags, PluginNotePorts};
use clack_extensions::params::{
    HostParams, HostParamsImplMainThread, HostParamsImplShared, ParamClearFlags, ParamInfoBuffer, ParamInfoFlags, ParamRescanFlags, PluginParams,
};
use clack_extensions::state::{HostState, HostStateImpl, PluginState};
use clack_extensions::timer::{HostTimer, HostTimerImpl, PluginTimer, TimerId};
use clack_host::events::event_types::{MidiEvent as ClapMidiEvent, NoteOffEvent, NoteOnEvent, ParamValueEvent, TransportEvent};
use clack_host::events::{EventFlags, EventHeader, Match, Pckn};
use clack_host::prelude::*;
use clack_host::utils::ClapId;
use raw_window_handle::RawWindowHandle;

use crate::error::BridgeError;
use crate::plugin::{
    EditorMode, MidiEvent, Notifier, ParamInfo, Plugin, PluginDescription, PluginFormat, PluginKind, PluginNotice, ProcessBuffers, ProcessSetup, Processor,
    Transport,
};

fn host_info() -> HostInfo {
    HostInfo::new("Juicy Loops Bridge", "Juicy Loops", "https://juicyloops.daspete.at", env!("CARGO_PKG_VERSION")).expect("host info has no NUL bytes")
}

fn load_entry(path: &Path) -> Result<PluginEntry, String> {
    // SAFETY: loading a plugin runs its code; that is the point of a plugin host. Scans do it in a child process.
    unsafe { PluginEntry::load(path) }.map_err(|error| format!("{error}"))
}

/// Kind from CLAP features: an instrument if it says so, else an effect if it processes audio. Note effects and
/// analyzers-only are not offered.
fn kind_from_features(features: &[String]) -> Option<PluginKind> {
    let has = |feature: &str| features.iter().any(|found| found.eq_ignore_ascii_case(feature));
    if has("instrument") {
        Some(PluginKind::Instrument)
    } else if has("audio-effect") || has("analyzer") {
        Some(PluginKind::Effect)
    } else {
        None
    }
}

/// Lists the plugins in one `.clap` file.
pub fn scan_file(path: &Path) -> Result<Vec<PluginDescription>, String> {
    let entry = load_entry(path)?;
    let factory = entry.get_plugin_factory().ok_or("the file has no plugin factory")?;
    let mut plugins = Vec::new();
    for descriptor in factory.plugin_descriptors() {
        let Some(id) = descriptor.id().and_then(|id| id.to_str().ok()) else { continue };
        let text = |value: Option<&CStr>| value.map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
        let features: Vec<String> = descriptor.features().map(|feature| feature.to_string_lossy().into_owned()).collect();
        let Some(kind) = kind_from_features(&features) else { continue };
        plugins.push(PluginDescription {
            id: format!("clap:{id}"),
            format: PluginFormat::Clap,
            native_id: id.to_string(),
            name: text(descriptor.name()),
            vendor: text(descriptor.vendor()),
            version: text(descriptor.version()),
            kind,
            categories: features.into_iter().filter(|feature| !["instrument", "audio-effect", "stereo", "mono"].contains(&feature.as_str())).collect(),
            path: path.to_path_buf(),
        });
    }
    Ok(plugins)
}

/* ---------------------------------------------------------------- host side */

pub struct BridgeHost;

impl HostHandlers for BridgeHost {
    type Shared<'a> = SharedState;
    type MainThread<'a> = MainThreadState<'a>;
    type AudioProcessor<'a> = ();

    fn declare_extensions(builder: &mut HostExtensions<Self>, _shared: &Self::Shared<'_>) {
        builder
            .register::<HostLog>()
            .register::<HostGui>()
            .register::<HostTimer>()
            .register::<HostParams>()
            .register::<HostState>()
            .register::<HostLatency>()
            .register::<HostAudioPorts>()
            .register::<HostNotePorts>();
        #[cfg(unix)]
        builder.register::<clack_extensions::posix_fd::HostPosixFd>();
    }
}

pub struct SharedState {
    notifier: Notifier,
    /// Set by `request_callback`: CLAP wants `on_main_thread` only when asked for.
    callback_requested: std::sync::atomic::AtomicBool,
}

impl SharedHandler<'_> for SharedState {
    fn request_restart(&self) {
        (self.notifier)(PluginNotice::RestartRequested);
    }

    fn request_process(&self) {
        // Blocks come from the studio; the bridge never puts a plugin to sleep.
    }

    fn request_callback(&self) {
        self.callback_requested.store(true, std::sync::atomic::Ordering::Release);
        (self.notifier)(PluginNotice::MainThreadCallback);
    }
}

impl HostLogImpl for SharedState {
    fn log(&self, severity: LogSeverity, message: &str) {
        match severity {
            LogSeverity::Debug => log::debug!("plugin: {message}"),
            LogSeverity::Info => log::info!("plugin: {message}"),
            _ => log::warn!("plugin: {message}"),
        }
    }
}

impl HostGuiImpl for SharedState {
    fn resize_hints_changed(&self) {}

    fn request_resize(&self, new_size: GuiSize) -> Result<(), HostError> {
        (self.notifier)(PluginNotice::EditorResize { width: new_size.width, height: new_size.height });
        Ok(())
    }

    fn request_show(&self) -> Result<(), HostError> {
        Ok(())
    }

    fn request_hide(&self) -> Result<(), HostError> {
        Ok(())
    }

    fn closed(&self, _was_destroyed: bool) {
        (self.notifier)(PluginNotice::EditorClosed);
    }
}

impl HostParamsImplShared for SharedState {
    fn request_flush(&self) {}
}

pub struct MainThreadState<'a> {
    shared: &'a SharedState,
    plugin: OnceCell<InitializedPluginHandle<'a>>,
    timers: RefCell<HashMap<u32, (Duration, Instant)>>,
    next_timer: Cell<u32>,
    #[cfg(unix)]
    fds: RefCell<HashMap<std::os::fd::RawFd, clack_extensions::posix_fd::FdFlags>>,
}

impl<'a> MainThreadHandler<'a> for MainThreadState<'a> {
    fn initialized(&self, instance: InitializedPluginHandle<'a>) {
        let _ = self.plugin.set(instance);
    }
}

impl HostTimerImpl for MainThreadState<'_> {
    fn register_timer(&self, period_ms: u32) -> Result<TimerId, HostError> {
        let id = self.next_timer.get() + 1;
        self.next_timer.set(id);
        let period = Duration::from_millis(period_ms.max(10) as u64);
        self.timers.borrow_mut().insert(id, (period, Instant::now() + period));
        Ok(TimerId(id))
    }

    fn unregister_timer(&self, timer_id: TimerId) -> Result<(), HostError> {
        self.timers.borrow_mut().remove(&timer_id.0).map(|_| ()).ok_or(HostError::Message("Unknown timer"))
    }
}

impl HostStateImpl for MainThreadState<'_> {
    fn mark_dirty(&self) {
        (self.shared.notifier)(PluginNotice::StateDirty);
    }
}

impl HostLatencyImpl for MainThreadState<'_> {
    fn changed(&self) {
        (self.shared.notifier)(PluginNotice::LatencyChanged);
    }
}

impl HostAudioPortsImpl for MainThreadState<'_> {
    fn is_rescan_flag_supported(&self, _flag: AudioPortRescanFlags) -> bool {
        false
    }

    fn rescan(&self, _flags: AudioPortRescanFlags) {}
}

impl HostNotePortsImpl for MainThreadState<'_> {
    fn supported_dialects(&self) -> NoteDialects {
        NoteDialects::CLAP | NoteDialects::MIDI
    }

    fn rescan(&self, _flags: NotePortRescanFlags) {}
}

impl HostParamsImplMainThread for MainThreadState<'_> {
    fn rescan(&self, _flags: ParamRescanFlags) {}

    fn clear(&self, _param_id: ClapId, _flags: ParamClearFlags) {}
}

#[cfg(unix)]
impl clack_extensions::posix_fd::HostPosixFdImpl for MainThreadState<'_> {
    fn register_fd(&self, fd: std::os::fd::RawFd, flags: clack_extensions::posix_fd::FdFlags) -> Result<(), HostError> {
        self.fds.borrow_mut().insert(fd, flags);
        Ok(())
    }

    fn modify_fd(&self, fd: std::os::fd::RawFd, flags: clack_extensions::posix_fd::FdFlags) -> Result<(), HostError> {
        self.fds.borrow_mut().insert(fd, flags);
        Ok(())
    }

    fn unregister_fd(&self, fd: std::os::fd::RawFd) -> Result<(), HostError> {
        self.fds.borrow_mut().remove(&fd);
        Ok(())
    }
}

/* ---------------------------------------------------------------- plugin */

struct Ports {
    /// Channels of each audio input and output port, and which is the main one.
    inputs: Vec<u32>,
    outputs: Vec<u32>,
    main_input: Option<usize>,
    main_output: Option<usize>,
    /// The note port index, and whether it only takes MIDI.
    notes: Option<(u16, bool)>,
}

pub struct ClapPlugin {
    description: PluginDescription,
    instance: PluginInstance<BridgeHost>,
    gui: Option<(PluginGui, GuiConfiguration<'static>)>,
    gui_open: bool,
    ports: Ports,
    params_to_audio: crossbeam_channel::Sender<(u32, f64)>,
    params_from_main: crossbeam_channel::Receiver<(u32, f64)>,
}

pub fn instantiate(description: &PluginDescription, notifier: Notifier) -> Result<Box<dyn Plugin>, BridgeError> {
    let entry = load_entry(&description.path).map_err(|error| BridgeError::plugin(format!("{} could not be loaded: {error}", description.name)))?;
    let id = CString::new(description.native_id.as_str()).map_err(|_| BridgeError::bad_request("Bad plugin id."))?;
    let mut instance = PluginInstance::<BridgeHost>::new(
        |_| SharedState { notifier, callback_requested: std::sync::atomic::AtomicBool::new(false) },
        |shared| MainThreadState {
            shared,
            plugin: OnceCell::new(),
            timers: RefCell::new(HashMap::new()),
            next_timer: Cell::new(0),
            #[cfg(unix)]
            fds: RefCell::new(HashMap::new()),
        },
        &entry,
        &id,
        &host_info(),
    )
    .map_err(|error| BridgeError::plugin(format!("{} could not start: {error}", description.name)))?;
    let ports = read_ports(&mut instance);
    let gui = negotiate_gui(&mut instance);
    let (params_to_audio, params_from_main) = crossbeam_channel::bounded(1024);
    Ok(Box::new(ClapPlugin { description: description.clone(), instance, gui, gui_open: false, ports, params_to_audio, params_from_main }))
}

fn read_ports(instance: &mut PluginInstance<BridgeHost>) -> Ports {
    let handle = instance.plugin_handle();
    let mut ports = Ports { inputs: Vec::new(), outputs: Vec::new(), main_input: None, main_output: None, notes: None };
    if let Some(audio_ports) = handle.get_extension::<PluginAudioPorts>() {
        let mut buffer = AudioPortInfoBuffer::new();
        for is_input in [true, false] {
            for index in 0..audio_ports.count(&handle, is_input).min(16) {
                let Some(info) = audio_ports.get(&handle, index, is_input, &mut buffer) else { continue };
                let is_main = info.flags.contains(clack_extensions::audio_ports::AudioPortFlags::IS_MAIN);
                let list = if is_input { &mut ports.inputs } else { &mut ports.outputs };
                list.push(info.channel_count);
                let main = if is_input { &mut ports.main_input } else { &mut ports.main_output };
                if is_main && main.is_none() {
                    *main = Some(list.len() - 1);
                }
            }
        }
        if ports.main_input.is_none() && !ports.inputs.is_empty() {
            ports.main_input = Some(0);
        }
        if ports.main_output.is_none() && !ports.outputs.is_empty() {
            ports.main_output = Some(0);
        }
    } else {
        // No audio-ports extension: CLAP says there are no ports then, but a stereo pair is what such plugins
        // mostly expect in practice.
        ports.outputs.push(2);
        ports.main_output = Some(0);
    }
    if let Some(note_ports) = handle.get_extension::<PluginNotePorts>() {
        let mut buffer = NotePortInfoBuffer::new();
        for index in 0..note_ports.count(&handle, true).min(u16::MAX as u32) {
            let Some(info) = note_ports.get(&handle, index, true, &mut buffer) else { continue };
            if info.supported_dialects.intersects(NoteDialects::CLAP | NoteDialects::MIDI) {
                ports.notes = Some((index as u16, !info.supported_dialects.intersects(NoteDialects::CLAP)));
                break;
            }
        }
    }
    ports
}

/// The platform's own window API, embedded if the plugin can, else floating.
fn negotiate_gui(instance: &mut PluginInstance<BridgeHost>) -> Option<(PluginGui, GuiConfiguration<'static>)> {
    let handle = instance.plugin_handle();
    let gui = handle.get_extension::<PluginGui>()?;
    let api_type = GuiApiType::default_for_current_platform()?;
    let mut configuration = GuiConfiguration { api_type, is_floating: false };
    if gui.is_api_supported(&handle, configuration) {
        return Some((gui, configuration));
    }
    configuration.is_floating = true;
    gui.is_api_supported(&handle, configuration).then_some((gui, configuration))
}

impl ClapPlugin {
    fn run_timers(&mut self) {
        let due: Vec<u32> = self.instance.access_handler(|main| {
            let now = Instant::now();
            let mut timers = main.timers.borrow_mut();
            let mut due = Vec::new();
            for (id, (period, next)) in timers.iter_mut() {
                if *next <= now {
                    due.push(*id);
                    *next = now + *period;
                }
            }
            due
        });
        if due.is_empty() {
            return;
        }
        let handle = self.instance.plugin_handle();
        if let Some(timer) = handle.get_extension::<PluginTimer>() {
            for id in due {
                timer.on_timer(&handle, TimerId(id));
            }
        }
    }

    #[cfg(unix)]
    fn poll_fds(&mut self) {
        use clack_extensions::posix_fd::{FdFlags, PluginPosixFd};
        let fds: Vec<(i32, FdFlags)> = self.instance.access_handler(|main| main.fds.borrow().iter().map(|(fd, flags)| (*fd, *flags)).collect());
        if fds.is_empty() {
            return;
        }
        let mut polled: Vec<libc::pollfd> = fds
            .iter()
            .map(|(fd, flags)| {
                let mut events = 0;
                if flags.contains(FdFlags::READ) {
                    events |= libc::POLLIN;
                }
                if flags.contains(FdFlags::WRITE) {
                    events |= libc::POLLOUT;
                }
                libc::pollfd { fd: *fd, events, revents: 0 }
            })
            .collect();
        // SAFETY: `polled` is a valid array of pollfd for its length; timeout 0 never blocks.
        let ready = unsafe { libc::poll(polled.as_mut_ptr(), polled.len() as libc::nfds_t, 0) };
        if ready <= 0 {
            return;
        }
        let handle = self.instance.plugin_handle();
        let Some(extension) = handle.get_extension::<PluginPosixFd>() else { return };
        for entry in polled.iter().filter(|entry| entry.revents != 0) {
            let mut flags = FdFlags::empty();
            if entry.revents & libc::POLLIN != 0 {
                flags |= FdFlags::READ;
            }
            if entry.revents & libc::POLLOUT != 0 {
                flags |= FdFlags::WRITE;
            }
            if entry.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
                flags |= FdFlags::ERROR;
            }
            extension.on_fd(&handle, entry.fd, flags);
        }
    }
}

impl Plugin for ClapPlugin {
    fn description(&self) -> &PluginDescription {
        &self.description
    }

    fn activate(&mut self, setup: ProcessSetup) -> Result<Box<dyn Processor>, BridgeError> {
        let configuration = PluginAudioConfiguration { sample_rate: setup.sample_rate, min_frames_count: 1, max_frames_count: setup.max_block };
        let stopped = self
            .instance
            .activate(|_, _| (), configuration)
            .map_err(|error| BridgeError::plugin(format!("{} could not start processing: {error}", self.description.name)))?;
        let block = setup.max_block as usize;
        let in_total: u32 = self.ports.inputs.iter().sum();
        let out_total: u32 = self.ports.outputs.iter().sum();
        Ok(Box::new(ClapProcessor {
            processor: Some(PluginAudioProcessor::Stopped(stopped)),
            input_ports: AudioPorts::with_capacity(in_total as usize, self.ports.inputs.len()),
            output_ports: AudioPorts::with_capacity(out_total as usize, self.ports.outputs.len()),
            inputs: self.ports.inputs.iter().map(|channels| vec![0.0; *channels as usize * block]).collect(),
            outputs: self.ports.outputs.iter().map(|channels| vec![0.0; *channels as usize * block]).collect(),
            input_channels: self.ports.inputs.clone(),
            output_channels: self.ports.outputs.clone(),
            main_input: self.ports.main_input,
            main_output: self.ports.main_output,
            notes: self.ports.notes,
            block,
            events: EventBuffer::with_capacity(1024),
            params: self.params_from_main.clone(),
            steady: 0,
            sample_rate: setup.sample_rate,
        }))
    }

    fn deactivate(&mut self, processor: Box<dyn Processor>) {
        let Ok(processor) = processor.into_any().downcast::<ClapProcessor>() else { return };
        let mut processor = *processor;
        if let Some(audio) = processor.processor.take() {
            // Strictly an audio-thread call, but nothing processes any more: the engine took the processor out.
            self.instance.deactivate(audio.into_stopped());
        }
    }

    fn save_state(&mut self) -> Result<Vec<u8>, BridgeError> {
        let handle = self.instance.plugin_handle();
        let state = handle.get_extension::<PluginState>().ok_or_else(|| BridgeError::unsupported("This plugin cannot save its settings."))?;
        let mut chunk = Vec::new();
        state.save(&handle, &mut chunk).map_err(|_| BridgeError::plugin("The plugin could not save its settings."))?;
        Ok(chunk)
    }

    fn load_state(&mut self, chunk: &[u8]) -> Result<(), BridgeError> {
        let handle = self.instance.plugin_handle();
        let state = handle.get_extension::<PluginState>().ok_or_else(|| BridgeError::unsupported("This plugin cannot load settings."))?;
        let mut reader = chunk;
        state.load(&handle, &mut reader).map_err(|_| BridgeError::plugin("The plugin refused these settings."))
    }

    fn params(&mut self) -> Vec<ParamInfo> {
        let handle = self.instance.plugin_handle();
        let Some(params) = handle.get_extension::<PluginParams>() else { return Vec::new() };
        let mut buffer = ParamInfoBuffer::new();
        let mut list = Vec::new();
        for index in 0..params.count(&handle) {
            let Some(info) = params.get_info(&handle, index, &mut buffer) else { continue };
            if info.flags.contains(ParamInfoFlags::IS_HIDDEN) {
                continue;
            }
            let id = info.id;
            let entry = ParamInfo {
                id: id.get(),
                name: String::from_utf8_lossy(info.name).into_owned(),
                module: String::from_utf8_lossy(info.module).into_owned(),
                min: info.min_value,
                max: info.max_value,
                default: info.default_value,
                value: 0.0,
                automatable: info.flags.contains(ParamInfoFlags::IS_AUTOMATABLE),
            };
            let value = params.get_value(&handle, id).unwrap_or(entry.default);
            list.push(ParamInfo { value, ..entry });
        }
        list
    }

    fn set_param(&mut self, id: u32, value: f64) -> Result<(), BridgeError> {
        self.params_to_audio.try_send((id, value)).map_err(|_| BridgeError::internal("Too many parameter changes at once."))
    }

    fn latency(&mut self) -> u32 {
        let handle = self.instance.plugin_handle();
        handle.get_extension::<PluginLatency>().map_or(0, |latency| latency.get(&handle))
    }

    fn idle(&mut self) {
        if self.instance.access_shared_handler(|shared| shared.callback_requested.swap(false, std::sync::atomic::Ordering::AcqRel)) {
            self.instance.call_on_main_thread_callback();
        }
        self.run_timers();
        #[cfg(unix)]
        self.poll_fds();
    }

    fn editor_mode(&mut self) -> Option<EditorMode> {
        self.gui.as_ref().map(|(_, configuration)| if configuration.is_floating { EditorMode::Floating } else { EditorMode::Embedded })
    }

    unsafe fn open_editor(&mut self, parent: Option<RawWindowHandle>, title: &str) -> Result<Option<(u32, u32)>, BridgeError> {
        let (gui, configuration) = self.gui.ok_or_else(|| BridgeError::unsupported("This plugin has no window of its own."))?;
        let handle = self.instance.plugin_handle();
        gui.create(&handle, configuration).map_err(|error| BridgeError::plugin(format!("The plugin could not make its window: {error}")))?;
        self.gui_open = true;
        let title = CString::new(title.replace('\0', "")).unwrap_or_default();
        gui.suggest_title(&handle, &title);
        if configuration.is_floating {
            gui.show(&handle).map_err(|error| BridgeError::plugin(format!("The plugin could not show its window: {error}")))?;
            return Ok(None);
        }
        let parent = parent.ok_or_else(|| BridgeError::internal("An embedded editor needs a window."))?;
        // SAFETY: the handles come from a live window (see above).
        let window = match parent {
            RawWindowHandle::Win32(handle) => unsafe { ClapWindow::from_win32_hwnd(handle.hwnd.get() as *mut _) },
            RawWindowHandle::AppKit(handle) => unsafe { ClapWindow::from_cocoa_nsview(handle.ns_view.as_ptr()) },
            RawWindowHandle::Xlib(handle) => ClapWindow::from_x11_handle(handle.window),
            RawWindowHandle::Xcb(handle) => ClapWindow::from_x11_handle(handle.window.get().into()),
            _ => return Err(BridgeError::unsupported("This kind of window cannot hold a plugin editor.")),
        };
        // SAFETY: the engine keeps the parent window alive until `close_editor`.
        unsafe { gui.set_parent(&handle, window) }.map_err(|error| BridgeError::plugin(format!("The plugin could not attach its window: {error}")))?;
        let _ = gui.show(&handle);
        let size = gui.get_size(&handle).map(|size| (size.width, size.height));
        Ok(size.or(Some((640, 480))))
    }

    fn editor_resizable(&mut self) -> bool {
        let handle = self.instance.plugin_handle();
        self.gui.is_some_and(|(gui, _)| gui.can_resize(&handle))
    }

    fn resize_editor(&mut self, width: u32, height: u32, scale: f64) -> Option<(u32, u32)> {
        let (gui, configuration) = self.gui?;
        let handle = self.instance.plugin_handle();
        let logical = configuration.api_type.uses_logical_size();
        let requested =
            if logical { GuiSize { width: (width as f64 / scale) as u32, height: (height as f64 / scale) as u32 } } else { GuiSize { width, height } };
        if !gui.can_resize(&handle) {
            return gui
                .get_size(&handle)
                .map(|size| if logical { ((size.width as f64 * scale) as u32, (size.height as f64 * scale) as u32) } else { (size.width, size.height) });
        }
        let size = gui.adjust_size(&handle, requested).unwrap_or(requested);
        let _ = gui.set_size(&handle, size);
        Some(if logical { ((size.width as f64 * scale) as u32, (size.height as f64 * scale) as u32) } else { (size.width, size.height) })
    }

    fn close_editor(&mut self) {
        if self.gui_open {
            self.gui_open = false;
            if let Some((gui, _)) = self.gui {
                let handle = self.instance.plugin_handle();
                gui.destroy(&handle);
            }
        }
    }
}

impl Drop for ClapPlugin {
    fn drop(&mut self) {
        self.close_editor();
    }
}

/* ---------------------------------------------------------------- audio side */

struct ClapProcessor {
    processor: Option<PluginAudioProcessor<BridgeHost>>,
    input_ports: AudioPorts,
    output_ports: AudioPorts,
    /// One buffer per port, its channels laid end to end (`block` frames each).
    inputs: Vec<Vec<f32>>,
    outputs: Vec<Vec<f32>>,
    input_channels: Vec<u32>,
    output_channels: Vec<u32>,
    main_input: Option<usize>,
    main_output: Option<usize>,
    notes: Option<(u16, bool)>,
    block: usize,
    events: EventBuffer,
    params: crossbeam_channel::Receiver<(u32, f64)>,
    steady: u64,
    sample_rate: f64,
}

impl ClapProcessor {
    fn fill_events(&mut self, events: &[MidiEvent]) {
        self.events.clear();
        while let Ok((id, value)) = self.params.try_recv() {
            if let Some(id) = ClapId::from_raw(id) {
                self.events.push(&ParamValueEvent::new(0, id, Pckn::match_all(), value));
            }
        }
        let Some((port, midi_only)) = self.notes else { return };
        for event in events {
            let channel = event.channel() as u16;
            let key = event.bytes[1] as u16;
            if !midi_only && event.is_note_on() {
                self.events.push(&NoteOnEvent::new(event.frame, Pckn::new(port, channel, key, Match::All), event.bytes[2] as f64 / 127.0));
            } else if !midi_only && event.is_note_off() {
                self.events.push(&NoteOffEvent::new(event.frame, Pckn::new(port, channel, key, Match::All), event.bytes[2] as f64 / 127.0));
            } else {
                self.events.push(&ClapMidiEvent::new(event.frame, port, event.bytes));
            }
        }
    }
}

fn transport_event(transport: &Transport) -> TransportEvent {
    let mut flags = clack_host::events::event_types::TransportFlags::HAS_TEMPO;
    if transport.playing {
        flags |= clack_host::events::event_types::TransportFlags::IS_PLAYING;
    }
    TransportEvent {
        header: EventHeader::new_core(0, EventFlags::empty()),
        flags,
        song_pos_beats: Default::default(),
        song_pos_seconds: Default::default(),
        tempo: transport.bpm,
        tempo_inc: 0.0,
        loop_start_beats: Default::default(),
        loop_end_beats: Default::default(),
        loop_start_seconds: Default::default(),
        loop_end_seconds: Default::default(),
        bar_start: Default::default(),
        bar_number: 0,
        time_signature_numerator: 4,
        time_signature_denominator: 4,
    }
}

impl Processor for ClapProcessor {
    fn process(&mut self, buffers: ProcessBuffers<'_, '_>, events: &[MidiEvent], transport: &Transport) -> Result<(), BridgeError> {
        let frames = (buffers.frames as usize).min(self.block);
        self.fill_events(events);
        // Input: the studio's channels into the main port (mono fans out), everything else silent.
        for (port, buffer) in self.inputs.iter_mut().enumerate() {
            let channels = self.input_channels[port] as usize;
            for channel in 0..channels {
                let target = &mut buffer[channel * self.block..channel * self.block + frames];
                match (Some(port) == self.main_input, buffers.inputs.get(channel).or(buffers.inputs.first())) {
                    (true, Some(source)) => target.copy_from_slice(&source[..frames]),
                    _ => target.fill(0.0),
                }
            }
        }
        let block = self.block;
        let input_channels = &self.input_channels;
        let output_channels = &self.output_channels;
        let inputs = self.input_ports.with_input_buffers(self.inputs.iter_mut().enumerate().map(|(port, buffer)| AudioPortBuffer {
            latency: 0,
            channels: AudioPortBufferType::f32_input_only(
                buffer.chunks_exact_mut(block).take(input_channels[port] as usize).map(|channel| InputChannel::variable(&mut channel[..frames])),
            ),
        }));
        let mut outputs = self.output_ports.with_output_buffers(self.outputs.iter_mut().enumerate().map(|(port, buffer)| AudioPortBuffer {
            latency: 0,
            channels: AudioPortBufferType::f32_output_only(
                buffer.chunks_exact_mut(block).take(output_channels[port] as usize).map(|channel| &mut channel[..frames]),
            ),
        }));
        let transport = transport_event(transport);
        let processor = self.processor.as_mut().ok_or_else(|| BridgeError::not_found("The instance is gone."))?;
        let started = processor.ensure_processing_started().map_err(|error| BridgeError::plugin(format!("The plugin could not start: {error}")))?;
        let result = started.process(&inputs, &mut outputs, &self.events.as_input(), &mut OutputEvents::void(), Some(self.steady), Some(&transport));
        self.steady += frames as u64;
        result.map_err(|error| BridgeError::plugin(format!("The plugin failed to process: {error}")))?;
        // Output: the main port's first two channels (mono doubled).
        for (index, output) in buffers.outputs.iter_mut().enumerate() {
            match self.main_output {
                Some(port) if self.output_channels[port] > 0 => {
                    let channel = index.min(self.output_channels[port] as usize - 1);
                    output[..frames].copy_from_slice(&self.outputs[port][channel * self.block..channel * self.block + frames]);
                }
                _ => output[..frames].fill(0.0),
            }
        }
        let _ = self.sample_rate;
        Ok(())
    }

    fn reset(&mut self) {
        if let Some(processor) = self.processor.as_mut() {
            processor.reset();
        }
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any + Send> {
        self
    }
}
