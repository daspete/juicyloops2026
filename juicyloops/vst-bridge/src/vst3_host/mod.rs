//! VST3 plugins, hosted on the `vst3` crate's bindings (MIT/Apache-2.0; the VST3 SDK itself is MIT since 3.8).
//!
//! One instance is a component (audio processor) plus an edit controller, separate objects or one. The host wires
//! them together (connection points, the component's state into the controller), passes the controller's edits
//! to the processor as parameter changes (VST3 has no other path), turns MIDI notes into note events and pitch
//! bend / controllers into parameters through the controller's MIDI mapping, and shows the editor (`IPlugView`)
//! in a window of its own, with a run loop for Linux editors.

// VST3's enum constants are u32 on some platforms and i32 on others: the casts are needed somewhere.
#![allow(clippy::unnecessary_cast)]

mod com;
pub mod module;

use std::any::Any;
use std::ffi::{c_char, c_void};
use std::path::Path;
use std::rc::Rc;

use raw_window_handle::RawWindowHandle;
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{ComPtr, ComWrapper, Interface};

use crate::error::BridgeError;
use crate::plugin::{
    EditorMode, MidiEvent, Notifier, ParamInfo, Plugin, PluginDescription, PluginFormat, PluginKind, ProcessBuffers, ProcessSetup, Processor, Transport,
};
use com::{ComponentHandler, EventList, HostApplication, MemoryStream, ParameterChanges, PlugFrame, RunLoop};

const AUDIO_MODULE_CLASS: &str = "Audio Module Class";

fn text8(chars: &[c_char]) -> String {
    let bytes: Vec<u8> = chars.iter().take_while(|character| **character != 0).map(|character| *character as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn text16(chars: &[TChar]) -> String {
    let length = chars.iter().position(|character| *character == 0).unwrap_or(chars.len());
    String::from_utf16_lossy(&chars[..length])
}

pub fn tuid_to_hex(tuid: &TUID) -> String {
    tuid.iter().map(|byte| format!("{:02X}", *byte as u8)).collect()
}

pub fn tuid_from_hex(hex: &str) -> Option<TUID> {
    if hex.len() != 32 || !hex.is_ascii() {
        return None;
    }
    let mut tuid = [0 as c_char; 16];
    for (index, slot) in tuid.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()? as c_char;
    }
    Some(tuid)
}

/// Lists the plugins in one `.vst3` bundle (loads it: scans run this in a child process).
pub fn scan_bundle(path: &Path) -> Result<Vec<PluginDescription>, String> {
    let module = module::module(path)?;
    let factory = &module.factory;
    let mut factory_info: PFactoryInfo = unsafe { std::mem::zeroed() };
    let factory_vendor = if unsafe { factory.getFactoryInfo(&mut factory_info) } == kResultOk { text8(&factory_info.vendor) } else { String::new() };
    let factory2 = factory.cast::<IPluginFactory2>();
    let mut plugins = Vec::new();
    let count = unsafe { factory.countClasses() };
    for index in 0..count {
        let (cid, category, name, sub_categories, vendor, version) = match &factory2 {
            Some(factory2) => {
                let mut info: PClassInfo2 = unsafe { std::mem::zeroed() };
                if unsafe { factory2.getClassInfo2(index, &mut info) } != kResultOk {
                    continue;
                }
                (info.cid, text8(&info.category), text8(&info.name), text8(&info.subCategories), text8(&info.vendor), text8(&info.version))
            }
            None => {
                let mut info: PClassInfo = unsafe { std::mem::zeroed() };
                if unsafe { factory.getClassInfo(index, &mut info) } != kResultOk {
                    continue;
                }
                (info.cid, text8(&info.category), text8(&info.name), String::new(), String::new(), String::new())
            }
        };
        if category != AUDIO_MODULE_CLASS {
            continue;
        }
        let categories: Vec<String> = sub_categories.split('|').filter(|part| !part.is_empty()).map(str::to_string).collect();
        let kind = if categories.iter().any(|category| category.eq_ignore_ascii_case("Instrument")) {
            PluginKind::Instrument
        } else if categories.iter().any(|category| category.eq_ignore_ascii_case("Fx")) {
            PluginKind::Effect
        } else {
            // An old-style factory without sub-categories: ask the component itself.
            probe_kind(&module, &cid)
        };
        let hex = tuid_to_hex(&cid);
        plugins.push(PluginDescription {
            id: format!("vst3:{hex}"),
            format: PluginFormat::Vst3,
            native_id: hex,
            name,
            vendor: if vendor.is_empty() { factory_vendor.clone() } else { vendor },
            version,
            kind,
            categories: categories.into_iter().filter(|category| category != "Instrument" && category != "Fx").collect(),
            path: path.to_path_buf(),
        });
    }
    Ok(plugins)
}

/// Instrument when it takes notes and no audio, effect otherwise.
fn probe_kind(module: &module::Module, cid: &TUID) -> PluginKind {
    let host = ComWrapper::new(HostApplication);
    let context = host.as_com_ref::<FUnknown>().map_or(std::ptr::null_mut(), |context| context.as_ptr());
    unsafe {
        let mut object = std::ptr::null_mut();
        if module.factory.createInstance(cid.as_ptr(), IComponent::IID.as_ptr() as *const c_char, &mut object) != kResultOk {
            return PluginKind::Effect;
        }
        let Some(component) = ComPtr::from_raw(object as *mut IComponent) else { return PluginKind::Effect };
        if component.initialize(context) != kResultOk {
            return PluginKind::Effect;
        }
        let events = component.getBusCount(MediaTypes_::kEvent as MediaType, BusDirections_::kInput as BusDirection);
        let audio = component.getBusCount(MediaTypes_::kAudio as MediaType, BusDirections_::kInput as BusDirection);
        component.terminate();
        if events > 0 && audio == 0 { PluginKind::Instrument } else { PluginKind::Effect }
    }
}

/// Channel count of a speaker arrangement (one bit per speaker).
fn channels_of(arrangement: SpeakerArrangement) -> u32 {
    arrangement.count_ones()
}

struct Bus {
    channels: u32,
    main: bool,
}

pub struct Vst3Plugin {
    description: PluginDescription,
    _module: Rc<module::Module>,
    component: ComPtr<IComponent>,
    processor: ComPtr<IAudioProcessor>,
    controller: Option<ComPtr<IEditController>>,
    /// Both halves' connection points, when they are separate objects (disconnected on drop).
    connection: Option<(ComPtr<IConnectionPoint>, ComPtr<IConnectionPoint>)>,
    separate_controller: bool,
    _host: ComWrapper<HostApplication>,
    handler: Option<ComWrapper<ComponentHandler>>,
    edits: crossbeam_channel::Receiver<(u32, f64)>,
    edits_in: crossbeam_channel::Sender<(u32, f64)>,
    notifier: Notifier,
    inputs: Vec<Bus>,
    outputs: Vec<Bus>,
    event_inputs: i32,
    active: bool,
    view: Option<ComPtr<IPlugView>>,
    frame: Option<ComWrapper<PlugFrame>>,
    run_loop: Rc<RunLoop>,
}

fn check(result: tresult, what: &str) -> Result<(), BridgeError> {
    if result == kResultOk { Ok(()) } else { Err(BridgeError::plugin(format!("The plugin failed to {what} (error {result})."))) }
}

pub fn instantiate(description: &PluginDescription, notifier: Notifier) -> Result<Box<dyn Plugin>, BridgeError> {
    let module = module::module(&description.path).map_err(|error| BridgeError::plugin(format!("{} could not be loaded: {error}", description.name)))?;
    let cid = tuid_from_hex(&description.native_id).ok_or_else(|| BridgeError::bad_request("Bad VST3 class id."))?;
    let host = ComWrapper::new(HostApplication);
    let host_context = host.as_com_ref::<FUnknown>().map_or(std::ptr::null_mut(), |context| context.as_ptr());

    let component: ComPtr<IComponent> = unsafe {
        let mut object = std::ptr::null_mut();
        let result = module.factory.createInstance(cid.as_ptr(), IComponent::IID.as_ptr() as *const c_char, &mut object);
        if result != kResultOk {
            return Err(BridgeError::plugin(format!("{} could not be created (error {result}).", description.name)));
        }
        ComPtr::from_raw(object as *mut IComponent).ok_or_else(|| BridgeError::plugin("The plugin gave no component."))?
    };
    check(unsafe { component.initialize(host_context) }, "initialize")?;
    let processor = component.cast::<IAudioProcessor>().ok_or_else(|| BridgeError::plugin("The plugin has no audio processor."))?;

    // The controller: the component itself, or a class of its own.
    let mut separate_controller = false;
    let controller = match component.cast::<IEditController>() {
        Some(controller) => Some(controller),
        None => {
            let mut controller_cid: TUID = [0; 16];
            if unsafe { component.getControllerClassId(&mut controller_cid) } == kResultOk && controller_cid != [0; 16] {
                unsafe {
                    let mut object = std::ptr::null_mut();
                    if module.factory.createInstance(controller_cid.as_ptr(), IEditController::IID.as_ptr() as *const c_char, &mut object) == kResultOk {
                        ComPtr::from_raw(object as *mut IEditController)
                            .filter(|controller| controller.initialize(host_context) == kResultOk)
                            .inspect(|_| separate_controller = true)
                    } else {
                        None
                    }
                }
            } else {
                None
            }
        }
    };

    let (edits_in, edits) = crossbeam_channel::bounded(4096);
    let mut plugin = Vst3Plugin {
        description: description.clone(),
        _module: module,
        component,
        processor,
        controller,
        connection: None,
        separate_controller,
        _host: host,
        handler: None,
        edits,
        edits_in,
        notifier,
        inputs: Vec::new(),
        outputs: Vec::new(),
        event_inputs: 0,
        active: false,
        view: None,
        frame: None,
        run_loop: Rc::new(RunLoop::default()),
    };
    plugin.connect_halves();
    plugin.read_buses();
    Ok(Box::new(plugin))
}

impl Vst3Plugin {
    fn connect_halves(&mut self) {
        if let Some(controller) = &self.controller {
            let handler = ComWrapper::new(ComponentHandler { edits: self.edits_in.clone(), notifier: self.notifier.clone() });
            if let Some(pointer) = handler.as_com_ref::<IComponentHandler>() {
                unsafe { controller.setComponentHandler(pointer.as_ptr()) };
            }
            self.handler = Some(handler);
            if self.separate_controller {
                if let (Some(a), Some(b)) = (self.component.cast::<IConnectionPoint>(), controller.cast::<IConnectionPoint>()) {
                    unsafe {
                        a.connect(b.as_ptr());
                        b.connect(a.as_ptr());
                    }
                    self.connection = Some((a, b));
                }
            }
        }
        self.sync_controller();
    }

    /// The controller learns the component's state (how a separate controller gets its values).
    fn sync_controller(&mut self) {
        if let (Some(controller), true) = (&self.controller, self.separate_controller) {
            let stream = MemoryStream::new(Vec::new());
            let pointer = stream.as_com_ref::<IBStream>().map_or(std::ptr::null_mut(), |stream| stream.as_ptr());
            if unsafe { self.component.getState(pointer) } == kResultOk {
                let state = MemoryStream::new(stream.take());
                let pointer = state.as_com_ref::<IBStream>().map_or(std::ptr::null_mut(), |stream| stream.as_ptr());
                unsafe { controller.setComponentState(pointer) };
            }
        }
    }

    fn read_buses(&mut self) {
        let read = |direction: BusDirection| -> Vec<Bus> {
            let count = unsafe { self.component.getBusCount(MediaTypes_::kAudio as MediaType, direction) };
            (0..count.max(0))
                .map(|index| {
                    let mut info: BusInfo = unsafe { std::mem::zeroed() };
                    unsafe { self.component.getBusInfo(MediaTypes_::kAudio as MediaType, direction, index, &mut info) };
                    Bus { channels: info.channelCount.max(0) as u32, main: info.busType == BusTypes_::kMain as BusType }
                })
                .collect()
        };
        self.inputs = read(BusDirections_::kInput as BusDirection);
        self.outputs = read(BusDirections_::kOutput as BusDirection);
        self.event_inputs = unsafe { self.component.getBusCount(MediaTypes_::kEvent as MediaType, BusDirections_::kInput as BusDirection) };
    }

    fn main_index(buses: &[Bus]) -> Option<usize> {
        buses.iter().position(|bus| bus.main).or(if buses.is_empty() { None } else { Some(0) })
    }

    /// Asks for stereo on the main buses, keeps whatever the others are, and reads back what the plugin agreed to.
    fn arrange_buses(&mut self) {
        let arrangement = |direction: BusDirection, index: usize, main: bool| -> SpeakerArrangement {
            if main {
                return SpeakerArr::kStereo;
            }
            let mut current: SpeakerArrangement = 0;
            unsafe { self.processor.getBusArrangement(direction, index as i32, &mut current) };
            current
        };
        let main_in = Self::main_index(&self.inputs);
        let main_out = Self::main_index(&self.outputs);
        let mut ins: Vec<SpeakerArrangement> =
            (0..self.inputs.len()).map(|index| arrangement(BusDirections_::kInput as BusDirection, index, Some(index) == main_in)).collect();
        let mut outs: Vec<SpeakerArrangement> =
            (0..self.outputs.len()).map(|index| arrangement(BusDirections_::kOutput as BusDirection, index, Some(index) == main_out)).collect();
        unsafe { self.processor.setBusArrangements(ins.as_mut_ptr(), ins.len() as i32, outs.as_mut_ptr(), outs.len() as i32) };
        // Whatever was accepted or not, the plugin's own view counts.
        for (index, bus) in self.inputs.iter_mut().enumerate() {
            let mut current: SpeakerArrangement = 0;
            if unsafe { self.processor.getBusArrangement(BusDirections_::kInput as BusDirection, index as i32, &mut current) } == kResultOk {
                bus.channels = channels_of(current);
            }
        }
        for (index, bus) in self.outputs.iter_mut().enumerate() {
            let mut current: SpeakerArrangement = 0;
            if unsafe { self.processor.getBusArrangement(BusDirections_::kOutput as BusDirection, index as i32, &mut current) } == kResultOk {
                bus.channels = channels_of(current);
            }
        }
        // Every bus stays active: aux inputs get silence, aux outputs are ignored.
        for (index, _) in self.inputs.iter().enumerate() {
            unsafe { self.component.activateBus(MediaTypes_::kAudio as MediaType, BusDirections_::kInput as BusDirection, index as i32, 1) };
        }
        for (index, _) in self.outputs.iter().enumerate() {
            unsafe { self.component.activateBus(MediaTypes_::kAudio as MediaType, BusDirections_::kOutput as BusDirection, index as i32, 1) };
        }
        if self.event_inputs > 0 {
            unsafe { self.component.activateBus(MediaTypes_::kEvent as MediaType, BusDirections_::kInput as BusDirection, 0, 1) };
        }
    }

    /// Which parameter each MIDI controller (0..127, aftertouch 128, pitch bend 129) of each channel drives.
    fn midi_map(&self) -> Box<[[Option<u32>; 130]; 16]> {
        let mut map = Box::new([[None; 130]; 16]);
        let Some(mapping) = self.controller.as_ref().and_then(|controller| controller.cast::<IMidiMapping>()) else { return map };
        for (channel, controllers) in map.iter_mut().enumerate() {
            for (number, slot) in controllers.iter_mut().enumerate() {
                let mut id: ParamID = 0;
                if unsafe { mapping.getMidiControllerAssignment(0, channel as i16, number as CtrlNumber, &mut id) } == kResultOk {
                    *slot = Some(id);
                }
            }
        }
        map
    }

    fn stream_state(&self, from_controller: bool) -> Option<Vec<u8>> {
        let stream = MemoryStream::new(Vec::new());
        let pointer = stream.as_com_ref::<IBStream>().map_or(std::ptr::null_mut(), |stream| stream.as_ptr());
        let result = if from_controller {
            match &self.controller {
                Some(controller) if self.separate_controller => unsafe { controller.getState(pointer) },
                _ => return Some(Vec::new()),
            }
        } else {
            unsafe { self.component.getState(pointer) }
        };
        (result == kResultOk).then(|| stream.take())
    }
}

/// Our state container: the component's and the controller's chunks, each with its length.
fn pack_state(component: &[u8], controller: &[u8]) -> Vec<u8> {
    let mut chunk = b"JLV3".to_vec();
    chunk.extend_from_slice(&(component.len() as u32).to_le_bytes());
    chunk.extend_from_slice(component);
    chunk.extend_from_slice(&(controller.len() as u32).to_le_bytes());
    chunk.extend_from_slice(controller);
    chunk
}

fn unpack_state(chunk: &[u8]) -> Option<(&[u8], &[u8])> {
    let rest = chunk.strip_prefix(b"JLV3")?;
    let length = u32::from_le_bytes(rest.get(..4)?.try_into().ok()?) as usize;
    let component = rest.get(4..4 + length)?;
    let rest = &rest[4 + length..];
    let length = u32::from_le_bytes(rest.get(..4)?.try_into().ok()?) as usize;
    let controller = rest.get(4..4 + length)?;
    Some((component, controller))
}

impl Plugin for Vst3Plugin {
    fn description(&self) -> &PluginDescription {
        &self.description
    }

    fn activate(&mut self, setup: ProcessSetup) -> Result<Box<dyn Processor>, BridgeError> {
        if unsafe { self.processor.canProcessSampleSize(SymbolicSampleSizes_::kSample32 as i32) } != kResultOk {
            return Err(BridgeError::unsupported("This plugin cannot process 32-bit audio."));
        }
        self.arrange_buses();
        let mut vst_setup = vst3::Steinberg::Vst::ProcessSetup {
            processMode: if setup.offline { ProcessModes_::kOffline as i32 } else { ProcessModes_::kRealtime as i32 },
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            maxSamplesPerBlock: setup.max_block as i32,
            sampleRate: setup.sample_rate,
        };
        check(unsafe { self.processor.setupProcessing(&mut vst_setup) }, "set up processing")?;
        check(unsafe { self.component.setActive(1) }, "activate")?;
        self.active = true;
        let block = setup.max_block as usize;
        let input_channels: Vec<u32> = self.inputs.iter().map(|bus| bus.channels).collect();
        let output_channels: Vec<u32> = self.outputs.iter().map(|bus| bus.channels).collect();
        let mut processor = Box::new(Vst3Processor {
            processor: self.processor.clone(),
            input_buffers: input_channels.iter().map(|channels| vec![0.0; *channels as usize * block]).collect(),
            output_buffers: output_channels.iter().map(|channels| vec![0.0; *channels as usize * block]).collect(),
            input_pointers: input_channels.iter().map(|channels| vec![std::ptr::null_mut(); *channels as usize]).collect(),
            output_pointers: output_channels.iter().map(|channels| vec![std::ptr::null_mut(); *channels as usize]).collect(),
            input_buses: Vec::new(),
            output_buses: Vec::new(),
            input_channels,
            output_channels,
            main_input: Self::main_index(&self.inputs),
            main_output: Self::main_index(&self.outputs),
            has_events: self.event_inputs > 0,
            events: EventList::new(1024),
            out_events: EventList::new(256),
            changes: ParameterChanges::new(128, 64),
            out_changes: ParameterChanges::new(128, 64),
            midi_map: self.midi_map(),
            edits: self.edits.clone(),
            block,
            sample_rate: setup.sample_rate,
            process_mode: vst_setup.processMode,
            processing: false,
            position: 0,
        });
        processor.bind_buffers();
        Ok(processor)
    }

    fn deactivate(&mut self, processor: Box<dyn Processor>) {
        if let Ok(processor) = processor.into_any().downcast::<Vst3Processor>() {
            if processor.processing {
                unsafe { self.processor.setProcessing(0) };
            }
        }
        if self.active {
            unsafe { self.component.setActive(0) };
            self.active = false;
        }
    }

    fn save_state(&mut self) -> Result<Vec<u8>, BridgeError> {
        let component = self.stream_state(false).ok_or_else(|| BridgeError::plugin("The plugin could not save its settings."))?;
        let controller = self.stream_state(true).unwrap_or_default();
        Ok(pack_state(&component, &controller))
    }

    fn load_state(&mut self, chunk: &[u8]) -> Result<(), BridgeError> {
        let (component, controller) = unpack_state(chunk).ok_or_else(|| BridgeError::bad_request("That is not a VST3 state from the bridge."))?;
        let stream = MemoryStream::new(component.to_vec());
        let pointer = stream.as_com_ref::<IBStream>().map_or(std::ptr::null_mut(), |stream| stream.as_ptr());
        check(unsafe { self.component.setState(pointer) }, "load its settings")?;
        // A single-object plugin has its state already; a separate controller learns it, then gets its own.
        if let (Some(controller_pointer), true) = (&self.controller, self.separate_controller) {
            let stream = MemoryStream::new(component.to_vec());
            let pointer = stream.as_com_ref::<IBStream>().map_or(std::ptr::null_mut(), |stream| stream.as_ptr());
            unsafe { controller_pointer.setComponentState(pointer) };
            if !controller.is_empty() {
                let stream = MemoryStream::new(controller.to_vec());
                let pointer = stream.as_com_ref::<IBStream>().map_or(std::ptr::null_mut(), |stream| stream.as_ptr());
                unsafe { controller_pointer.setState(pointer) };
            }
        }
        Ok(())
    }

    fn params(&mut self) -> Vec<ParamInfo> {
        let Some(controller) = &self.controller else { return Vec::new() };
        let count = unsafe { controller.getParameterCount() };
        let mut list = Vec::new();
        for index in 0..count {
            let mut info: ParameterInfo = unsafe { std::mem::zeroed() };
            if unsafe { controller.getParameterInfo(index, &mut info) } != kResultOk {
                continue;
            }
            if info.flags & ParameterInfo_::ParameterFlags_::kIsHidden != 0 {
                continue;
            }
            list.push(ParamInfo {
                id: info.id,
                name: text16(&info.title),
                module: String::new(),
                min: 0.0,
                max: 1.0,
                default: info.defaultNormalizedValue,
                value: unsafe { controller.getParamNormalized(info.id) },
                automatable: info.flags & ParameterInfo_::ParameterFlags_::kCanAutomate != 0,
            });
        }
        list
    }

    fn set_param(&mut self, id: u32, value: f64) -> Result<(), BridgeError> {
        let value = value.clamp(0.0, 1.0);
        if let Some(controller) = &self.controller {
            unsafe { controller.setParamNormalized(id, value) };
        }
        self.edits_in.try_send((id, value)).map_err(|_| BridgeError::internal("Too many parameter changes at once."))
    }

    fn latency(&mut self) -> u32 {
        unsafe { self.processor.getLatencySamples() }
    }

    fn idle(&mut self) {
        self.run_loop.tick();
    }

    fn editor_mode(&mut self) -> Option<EditorMode> {
        // Whether there is a view is only known by asking for one; ask once and keep it (closed) for later.
        let controller = self.controller.as_ref()?;
        if self.view.is_none() {
            let view = unsafe { controller.createView(ViewType::kEditor) };
            self.view = unsafe { ComPtr::from_raw(view) };
        }
        let view = self.view.as_ref()?;
        (unsafe { view.isPlatformTypeSupported(platform_type()) } == kResultTrue).then_some(EditorMode::Embedded)
    }

    unsafe fn open_editor(&mut self, parent: Option<RawWindowHandle>, _title: &str) -> Result<Option<(u32, u32)>, BridgeError> {
        if self.editor_mode().is_none() {
            return Err(BridgeError::unsupported("This plugin has no window this computer can show."));
        }
        let view = self.view.clone().ok_or_else(|| BridgeError::unsupported("This plugin has no window of its own."))?;
        let parent = parent.ok_or_else(|| BridgeError::internal("A VST3 editor needs a window."))?;
        let native: *mut c_void = match parent {
            RawWindowHandle::Win32(handle) => handle.hwnd.get() as *mut c_void,
            RawWindowHandle::AppKit(handle) => handle.ns_view.as_ptr(),
            RawWindowHandle::Xlib(handle) => handle.window as usize as *mut c_void,
            RawWindowHandle::Xcb(handle) => handle.window.get() as usize as *mut c_void,
            _ => return Err(BridgeError::unsupported("This kind of window cannot hold a plugin editor.")),
        };
        let frame = ComWrapper::new(PlugFrame { notifier: self.notifier.clone(), run_loop: self.run_loop.clone() });
        unsafe {
            if let Some(pointer) = frame.as_com_ref::<IPlugFrame>() {
                view.setFrame(pointer.as_ptr());
            }
            if let Err(error) = check(view.attached(native, platform_type()), "open its window") {
                view.setFrame(std::ptr::null_mut());
                return Err(error);
            }
        }
        self.frame = Some(frame);
        let mut rect = ViewRect { left: 0, top: 0, right: 0, bottom: 0 };
        let size = if unsafe { view.getSize(&mut rect) } == kResultOk {
            Some(((rect.right - rect.left).max(1) as u32, (rect.bottom - rect.top).max(1) as u32))
        } else {
            None
        };
        Ok(size)
    }

    fn editor_resizable(&mut self) -> bool {
        self.view.as_ref().is_some_and(|view| unsafe { view.canResize() } == kResultTrue)
    }

    fn resize_editor(&mut self, width: u32, height: u32, scale: f64) -> Option<(u32, u32)> {
        let view = self.view.as_ref()?;
        let (width, height) =
            if cfg!(target_os = "macos") { ((width as f64 / scale) as i32, (height as f64 / scale) as i32) } else { (width as i32, height as i32) };
        let mut rect = ViewRect { left: 0, top: 0, right: width, bottom: height };
        unsafe {
            if view.canResize() != kResultTrue {
                view.getSize(&mut rect);
            } else {
                view.checkSizeConstraint(&mut rect);
                view.onSize(&mut rect);
            }
        }
        let (width, height) = ((rect.right - rect.left).max(1) as f64, (rect.bottom - rect.top).max(1) as f64);
        Some(if cfg!(target_os = "macos") { ((width * scale) as u32, (height * scale) as u32) } else { (width as u32, height as u32) })
    }

    fn close_editor(&mut self) {
        if self.frame.take().is_some() {
            if let Some(view) = self.view.take() {
                unsafe {
                    view.removed();
                    view.setFrame(std::ptr::null_mut());
                }
            }
        }
    }
}

fn platform_type() -> FIDString {
    if cfg!(target_os = "windows") {
        kPlatformTypeHWND
    } else if cfg!(target_os = "macos") {
        kPlatformTypeNSView
    } else {
        kPlatformTypeX11EmbedWindowID
    }
}

impl Drop for Vst3Plugin {
    fn drop(&mut self) {
        self.close_editor();
        self.view = None;
        if self.active {
            unsafe { self.component.setActive(0) };
        }
        unsafe {
            if let Some((a, b)) = self.connection.take() {
                a.disconnect(b.as_ptr());
                b.disconnect(a.as_ptr());
            }
            if let Some(controller) = self.controller.take() {
                controller.setComponentHandler(std::ptr::null_mut());
                if self.separate_controller {
                    controller.terminate();
                }
            }
            self.component.terminate();
        }
    }
}

/* ---------------------------------------------------------------- audio side */

struct Vst3Processor {
    processor: ComPtr<IAudioProcessor>,
    input_buffers: Vec<Vec<f32>>,
    output_buffers: Vec<Vec<f32>>,
    input_pointers: Vec<Vec<*mut f32>>,
    output_pointers: Vec<Vec<*mut f32>>,
    input_buses: Vec<AudioBusBuffers>,
    output_buses: Vec<AudioBusBuffers>,
    input_channels: Vec<u32>,
    output_channels: Vec<u32>,
    main_input: Option<usize>,
    main_output: Option<usize>,
    has_events: bool,
    events: ComWrapper<EventList>,
    out_events: ComWrapper<EventList>,
    changes: ComWrapper<ParameterChanges>,
    out_changes: ComWrapper<ParameterChanges>,
    midi_map: Box<[[Option<u32>; 130]; 16]>,
    edits: crossbeam_channel::Receiver<(u32, f64)>,
    block: usize,
    sample_rate: f64,
    process_mode: i32,
    processing: bool,
    position: i64,
}

// SAFETY: VST3 lets the audio processor be driven from the audio thread, and this struct is only ever used by one
// thread at a time (the engine hands it over through a mutex). Its COM objects are the host's own.
unsafe impl Send for Vst3Processor {}

impl Vst3Processor {
    /// Points the bus structures at the buffers (both are fixed after this).
    fn bind_buffers(&mut self) {
        let block = self.block;
        for (bus, buffer) in self.input_buffers.iter_mut().enumerate() {
            for (channel, pointer) in self.input_pointers[bus].iter_mut().enumerate() {
                *pointer = buffer[channel * block..].as_mut_ptr();
            }
        }
        for (bus, buffer) in self.output_buffers.iter_mut().enumerate() {
            for (channel, pointer) in self.output_pointers[bus].iter_mut().enumerate() {
                *pointer = buffer[channel * block..].as_mut_ptr();
            }
        }
        self.input_buses = self
            .input_pointers
            .iter_mut()
            .map(|pointers| AudioBusBuffers {
                numChannels: pointers.len() as i32,
                silenceFlags: 0,
                __field0: AudioBusBuffers__type0 { channelBuffers32: pointers.as_mut_ptr() },
            })
            .collect();
        self.output_buses = self
            .output_pointers
            .iter_mut()
            .map(|pointers| AudioBusBuffers {
                numChannels: pointers.len() as i32,
                silenceFlags: 0,
                __field0: AudioBusBuffers__type0 { channelBuffers32: pointers.as_mut_ptr() },
            })
            .collect();
    }

    fn fill_events(&mut self, events: &[MidiEvent]) {
        self.events.clear();
        self.changes.clear();
        self.out_changes.clear();
        self.out_events.clear();
        while let Ok((id, value)) = self.edits.try_recv() {
            self.changes.add(id, 0, value);
        }
        for event in events {
            let channel = event.channel() as usize;
            let offset = event.frame as i32;
            let note = |kind: u32| Event {
                busIndex: 0,
                sampleOffset: offset,
                ppqPosition: 0.0,
                flags: Event_::EventFlags_::kIsLive as u16,
                r#type: kind as u16,
                __field0: unsafe { std::mem::zeroed() },
            };
            if event.is_note_on() && self.has_events {
                let mut out = note(Event_::EventTypes_::kNoteOnEvent as u32);
                out.__field0.noteOn = NoteOnEvent {
                    channel: channel as i16,
                    pitch: event.bytes[1] as i16,
                    tuning: 0.0,
                    velocity: event.bytes[2] as f32 / 127.0,
                    length: 0,
                    noteId: -1,
                };
                self.events.push(out);
            } else if event.is_note_off() && self.has_events {
                let mut out = note(Event_::EventTypes_::kNoteOffEvent as u32);
                out.__field0.noteOff =
                    NoteOffEvent { channel: channel as i16, pitch: event.bytes[1] as i16, velocity: event.bytes[2] as f32 / 127.0, noteId: -1, tuning: 0.0 };
                self.events.push(out);
            } else {
                // Controllers become parameters, through the plugin's own MIDI mapping.
                let (controller, value) = match event.status() {
                    0xb0 => (event.bytes[1] as usize, event.bytes[2] as f64 / 127.0),
                    0xd0 => (ControllerNumbers_::kAfterTouch as usize, event.bytes[1] as f64 / 127.0),
                    0xe0 => (ControllerNumbers_::kPitchBend as usize, ((event.bytes[1] as u32 | (event.bytes[2] as u32) << 7) as f64 / 16383.0)),
                    _ => continue,
                };
                if let Some(Some(id)) = self.midi_map.get(channel).and_then(|map| map.get(controller)) {
                    self.changes.add(*id, offset, value);
                }
            }
        }
    }
}

impl Processor for Vst3Processor {
    fn process(&mut self, buffers: ProcessBuffers<'_, '_>, events: &[MidiEvent], transport: &Transport) -> Result<(), BridgeError> {
        let frames = (buffers.frames as usize).min(self.block);
        if !self.processing {
            unsafe { self.processor.setProcessing(1) };
            self.processing = true;
        }
        for (bus, buffer) in self.input_buffers.iter_mut().enumerate() {
            for channel in 0..self.input_channels[bus] as usize {
                let target = &mut buffer[channel * self.block..channel * self.block + frames];
                match (Some(bus) == self.main_input, buffers.inputs.get(channel).or(buffers.inputs.first())) {
                    (true, Some(source)) => target.copy_from_slice(&source[..frames]),
                    _ => target.fill(0.0),
                }
            }
        }
        self.fill_events(events);
        let mut context: vst3::Steinberg::Vst::ProcessContext = unsafe { std::mem::zeroed() };
        context.state = ProcessContext_::StatesAndFlags_::kTempoValid as u32
            | ProcessContext_::StatesAndFlags_::kTimeSigValid as u32
            | if transport.playing { ProcessContext_::StatesAndFlags_::kPlaying as u32 } else { 0 };
        context.sampleRate = self.sample_rate;
        context.tempo = transport.bpm;
        context.timeSigNumerator = 4;
        context.timeSigDenominator = 4;
        context.continousTimeSamples = self.position;
        context.projectTimeSamples = self.position;
        let mut data = vst3::Steinberg::Vst::ProcessData {
            processMode: self.process_mode,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: frames as i32,
            numInputs: self.input_buses.len() as i32,
            numOutputs: self.output_buses.len() as i32,
            inputs: if self.input_buses.is_empty() { std::ptr::null_mut() } else { self.input_buses.as_mut_ptr() },
            outputs: if self.output_buses.is_empty() { std::ptr::null_mut() } else { self.output_buses.as_mut_ptr() },
            inputParameterChanges: self.changes.as_com_ref::<IParameterChanges>().map_or(std::ptr::null_mut(), |changes| changes.as_ptr()),
            outputParameterChanges: self.out_changes.as_com_ref::<IParameterChanges>().map_or(std::ptr::null_mut(), |changes| changes.as_ptr()),
            inputEvents: self.events.as_com_ref::<IEventList>().map_or(std::ptr::null_mut(), |events| events.as_ptr()),
            outputEvents: self.out_events.as_com_ref::<IEventList>().map_or(std::ptr::null_mut(), |events| events.as_ptr()),
            processContext: &mut context,
        };
        let result = unsafe { self.processor.process(&mut data) };
        self.position += frames as i64;
        if result != kResultOk {
            return Err(BridgeError::plugin(format!("The plugin failed to process (error {result}).")));
        }
        for (index, output) in buffers.outputs.iter_mut().enumerate() {
            match self.main_output {
                Some(bus) if self.output_channels[bus] > 0 => {
                    let channel = index.min(self.output_channels[bus] as usize - 1);
                    output[..frames].copy_from_slice(&self.output_buffers[bus][channel * self.block..channel * self.block + frames]);
                }
                _ => output[..frames].fill(0.0),
            }
        }
        Ok(())
    }

    fn reset(&mut self) {
        // VST3 has no reset: stopping and starting processing is what hosts do between renders.
        if self.processing {
            unsafe {
                self.processor.setProcessing(0);
                self.processor.setProcessing(1);
            }
        }
        self.position = 0;
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any + Send> {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_ids_round_trip_through_hex() {
        let tuid: TUID = [1, -2, 3, 127, -128, 0, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
        let hex = tuid_to_hex(&tuid);
        assert_eq!(hex.len(), 32);
        assert_eq!(tuid_from_hex(&hex), Some(tuid));
        assert_eq!(tuid_from_hex("nope"), None);
    }

    #[test]
    fn state_chunks_pack_both_halves() {
        let chunk = pack_state(b"component", b"ctl");
        assert_eq!(unpack_state(&chunk), Some((&b"component"[..], &b"ctl"[..])));
        assert_eq!(unpack_state(b"JLV3\xff\xff\xff\xff"), None);
        assert_eq!(unpack_state(b"XXXX"), None);
    }

    #[test]
    fn arrangements_count_their_speakers() {
        assert_eq!(channels_of(SpeakerArr::kStereo), 2);
        assert_eq!(channels_of(SpeakerArr::kMono), 1);
    }
}
