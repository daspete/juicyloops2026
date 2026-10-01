//! The host's side of VST3: the COM objects a host hands to plugins (host context, messages, streams, event and
//! parameter lists, the component handler, the editor frame and its run loop). Written against the `vst3` crate
//! (MIT/Apache-2.0); the message and attribute-list shapes follow `vst3-host` (MIT).

#![allow(non_snake_case, clippy::unnecessary_cast)]

use std::cell::{Cell, RefCell, UnsafeCell};
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::ptr;
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[cfg(any(target_os = "linux", test))]
use vst3::ComPtr;
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{Class, ComRef, ComWrapper, Interface};

use crate::plugin::{Notifier, PluginNotice};
#[cfg(target_os = "linux")]
use vst3::Steinberg::Linux::{IEventHandlerTrait, ITimerHandlerTrait};

fn write_string128(target: &mut String128, text: &str) {
    let mut length = 0;
    for (slot, unit) in target.iter_mut().zip(text.encode_utf16().take(127)) {
        *slot = unit;
        length += 1;
    }
    target[length] = 0;
}

fn same_iid(pointer: *const TUID, iid: &[u8; 16]) -> bool {
    // SAFETY: callers pass a pointer to 16 bytes (a TUID).
    !pointer.is_null() && unsafe { std::slice::from_raw_parts(pointer as *const u8, 16) } == &iid[..]
}

/* ---------------------------------------------------------------- host context */

pub struct HostApplication;

impl Class for HostApplication {
    type Interfaces = (IHostApplication, IPlugInterfaceSupport);
}

impl IHostApplicationTrait for HostApplication {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        if name.is_null() {
            return kInvalidArgument;
        }
        write_string128(unsafe { &mut *name }, "Juicy Loops Bridge");
        kResultOk
    }

    unsafe fn createInstance(&self, cid: *mut TUID, iid: *mut TUID, obj: *mut *mut c_void) -> tresult {
        if obj.is_null() {
            return kInvalidArgument;
        }
        unsafe { *obj = ptr::null_mut() };
        if same_iid(cid, &IMessage::IID) && same_iid(iid, &IMessage::IID) {
            if let Some(message) = ComWrapper::new(Message::default()).to_com_ptr::<IMessage>() {
                unsafe { *obj = message.into_raw() as *mut c_void };
                return kResultOk;
            }
        }
        if same_iid(cid, &IAttributeList::IID) && same_iid(iid, &IAttributeList::IID) {
            if let Some(list) = ComWrapper::new(AttributeList::default()).to_com_ptr::<IAttributeList>() {
                unsafe { *obj = list.into_raw() as *mut c_void };
                return kResultOk;
            }
        }
        kNoInterface
    }
}

impl IPlugInterfaceSupportTrait for HostApplication {
    unsafe fn isPlugInterfaceSupported(&self, iid: *const TUID) -> tresult {
        let supported: [&[u8; 16]; 4] = [&IConnectionPoint::IID, &IMidiMapping::IID, &IProcessContextRequirements::IID, &IPlugViewContentScaleSupport::IID];
        if supported.iter().any(|known| same_iid(iid, known)) { kResultTrue } else { kResultFalse }
    }
}

/* ---------------------------------------------------------------- messages */

#[derive(Clone)]
enum Attribute {
    Int(i64),
    Float(f64),
    Text(Vec<u16>),
    Binary(Vec<u8>),
}

#[derive(Default)]
pub struct AttributeList {
    values: Mutex<HashMap<String, Attribute>>,
}

unsafe fn key(id: *const c_char) -> String {
    if id.is_null() { String::new() } else { unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned() }
}

impl AttributeList {
    fn put(&self, id: *const c_char, value: Attribute) -> tresult {
        // SAFETY: plugins pass a C string id.
        let key = unsafe { key(id) };
        self.values.lock().unwrap_or_else(|poison| poison.into_inner()).insert(key, value);
        kResultOk
    }

    fn get(&self, id: *const c_char) -> Option<Attribute> {
        let key = unsafe { key(id) };
        self.values.lock().unwrap_or_else(|poison| poison.into_inner()).get(&key).cloned()
    }
}

impl Class for AttributeList {
    type Interfaces = (IAttributeList,);
}

impl IAttributeListTrait for AttributeList {
    unsafe fn setInt(&self, id: *const c_char, value: i64) -> tresult {
        self.put(id, Attribute::Int(value))
    }

    unsafe fn getInt(&self, id: *const c_char, value: *mut i64) -> tresult {
        match self.get(id) {
            Some(Attribute::Int(found)) if !value.is_null() => {
                unsafe { *value = found };
                kResultOk
            }
            _ => kResultFalse,
        }
    }

    unsafe fn setFloat(&self, id: *const c_char, value: f64) -> tresult {
        self.put(id, Attribute::Float(value))
    }

    unsafe fn getFloat(&self, id: *const c_char, value: *mut f64) -> tresult {
        match self.get(id) {
            Some(Attribute::Float(found)) if !value.is_null() => {
                unsafe { *value = found };
                kResultOk
            }
            _ => kResultFalse,
        }
    }

    unsafe fn setString(&self, id: *const c_char, string: *const TChar) -> tresult {
        if string.is_null() {
            return kInvalidArgument;
        }
        let mut text = Vec::new();
        let mut at = string;
        unsafe {
            while *at != 0 {
                text.push(*at);
                at = at.add(1);
            }
        }
        self.put(id, Attribute::Text(text))
    }

    unsafe fn getString(&self, id: *const c_char, string: *mut TChar, sizeInBytes: u32) -> tresult {
        match self.get(id) {
            Some(Attribute::Text(text)) if !string.is_null() && sizeInBytes >= 2 => {
                let room = (sizeInBytes as usize / 2) - 1;
                let count = text.len().min(room);
                unsafe {
                    ptr::copy_nonoverlapping(text.as_ptr(), string, count);
                    *string.add(count) = 0;
                }
                kResultOk
            }
            _ => kResultFalse,
        }
    }

    unsafe fn setBinary(&self, id: *const c_char, data: *const c_void, sizeInBytes: u32) -> tresult {
        if data.is_null() && sizeInBytes > 0 {
            return kInvalidArgument;
        }
        let bytes = if sizeInBytes == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(data as *const u8, sizeInBytes as usize) }.to_vec() };
        self.put(id, Attribute::Binary(bytes))
    }

    unsafe fn getBinary(&self, id: *const c_char, data: *mut *const c_void, sizeInBytes: *mut u32) -> tresult {
        if data.is_null() || sizeInBytes.is_null() {
            return kInvalidArgument;
        }
        let key = unsafe { key(id) };
        let values = self.values.lock().unwrap_or_else(|poison| poison.into_inner());
        match values.get(&key) {
            // The pointer stays valid while the entry is not replaced (plugins read it right away).
            Some(Attribute::Binary(bytes)) => {
                unsafe {
                    *data = bytes.as_ptr() as *const c_void;
                    *sizeInBytes = bytes.len() as u32;
                }
                kResultOk
            }
            _ => kResultFalse,
        }
    }
}

pub struct Message {
    id: Mutex<Option<CString>>,
    attributes: ComWrapper<AttributeList>,
}

impl Default for Message {
    fn default() -> Self {
        Self { id: Mutex::new(None), attributes: ComWrapper::new(AttributeList::default()) }
    }
}

impl Class for Message {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for Message {
    unsafe fn getMessageID(&self) -> FIDString {
        self.id.lock().unwrap_or_else(|poison| poison.into_inner()).as_ref().map_or(ptr::null(), |id| id.as_ptr())
    }

    unsafe fn setMessageID(&self, id: FIDString) {
        let id = if id.is_null() { None } else { Some(unsafe { CStr::from_ptr(id) }.to_owned()) };
        *self.id.lock().unwrap_or_else(|poison| poison.into_inner()) = id;
    }

    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        // Borrowed: the message keeps its list alive.
        self.attributes.as_com_ref::<IAttributeList>().map_or(ptr::null_mut(), |list| list.as_ptr())
    }
}

/* ---------------------------------------------------------------- streams */

/// A growable in-memory `IBStream` (plugin state in and out).
pub struct MemoryStream {
    data: RefCell<Vec<u8>>,
    position: Cell<usize>,
}

impl MemoryStream {
    pub fn new(data: Vec<u8>) -> ComWrapper<MemoryStream> {
        ComWrapper::new(MemoryStream { data: RefCell::new(data), position: Cell::new(0) })
    }

    pub fn take(&self) -> Vec<u8> {
        self.data.borrow().clone()
    }
}

impl Class for MemoryStream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for MemoryStream {
    unsafe fn read(&self, buffer: *mut c_void, numBytes: int32, numBytesRead: *mut int32) -> tresult {
        if buffer.is_null() || numBytes < 0 {
            return kInvalidArgument;
        }
        let data = self.data.borrow();
        let position = self.position.get().min(data.len());
        let count = (numBytes as usize).min(data.len() - position);
        unsafe { ptr::copy_nonoverlapping(data.as_ptr().add(position), buffer as *mut u8, count) };
        self.position.set(position + count);
        if !numBytesRead.is_null() {
            unsafe { *numBytesRead = count as int32 };
        }
        kResultOk
    }

    unsafe fn write(&self, buffer: *mut c_void, numBytes: int32, numBytesWritten: *mut int32) -> tresult {
        if buffer.is_null() || numBytes < 0 {
            return kInvalidArgument;
        }
        let mut data = self.data.borrow_mut();
        let position = self.position.get();
        let end = position + numBytes as usize;
        if data.len() < end {
            data.resize(end, 0);
        }
        unsafe { ptr::copy_nonoverlapping(buffer as *const u8, data.as_mut_ptr().add(position), numBytes as usize) };
        self.position.set(end);
        if !numBytesWritten.is_null() {
            unsafe { *numBytesWritten = numBytes };
        }
        kResultOk
    }

    unsafe fn seek(&self, pos: int64, mode: int32, result: *mut int64) -> tresult {
        let length = self.data.borrow().len() as i64;
        use IBStream_::IStreamSeekMode_::{kIBSeekCur, kIBSeekEnd, kIBSeekSet};
        let base = match mode as i64 {
            mode if mode == kIBSeekSet as i64 => 0,
            mode if mode == kIBSeekCur as i64 => self.position.get() as i64,
            mode if mode == kIBSeekEnd as i64 => length,
            _ => return kInvalidArgument,
        };
        let target = base + pos;
        if target < 0 {
            return kInvalidArgument;
        }
        self.position.set(target as usize);
        if !result.is_null() {
            unsafe { *result = target };
        }
        kResultOk
    }

    unsafe fn tell(&self, pos: *mut int64) -> tresult {
        if pos.is_null() {
            return kInvalidArgument;
        }
        unsafe { *pos = self.position.get() as int64 };
        kResultOk
    }
}

/* ---------------------------------------------------------------- events and parameter changes (audio thread) */

/// Events for one process call. Capacity is fixed up front: adding never allocates.
pub struct EventList {
    events: UnsafeCell<Vec<Event>>,
}

impl EventList {
    pub fn new(capacity: usize) -> ComWrapper<EventList> {
        ComWrapper::new(EventList { events: UnsafeCell::new(Vec::with_capacity(capacity)) })
    }

    /// Only from the thread that processes, never while the plugin holds the list.
    pub fn clear(&self) {
        unsafe { (*self.events.get()).clear() };
    }

    pub fn push(&self, event: Event) {
        let events = unsafe { &mut *self.events.get() };
        if events.len() < events.capacity() {
            events.push(event);
        }
    }
}

impl Class for EventList {
    type Interfaces = (IEventList,);
}

impl IEventListTrait for EventList {
    unsafe fn getEventCount(&self) -> int32 {
        unsafe { (*self.events.get()).len() as int32 }
    }

    unsafe fn getEvent(&self, index: int32, e: *mut Event) -> tresult {
        let events = unsafe { &*self.events.get() };
        match events.get(index as usize) {
            Some(event) if !e.is_null() => {
                unsafe { *e = *event };
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn addEvent(&self, e: *mut Event) -> tresult {
        if e.is_null() {
            return kInvalidArgument;
        }
        let events = unsafe { &mut *self.events.get() };
        if events.len() == events.capacity() {
            return kResultFalse;
        }
        events.push(unsafe { *e });
        kResultOk
    }
}

pub struct ParamQueue {
    id: Cell<ParamID>,
    points: UnsafeCell<Vec<(int32, ParamValue)>>,
}

impl Class for ParamQueue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for ParamQueue {
    unsafe fn getParameterId(&self) -> ParamID {
        self.id.get()
    }

    unsafe fn getPointCount(&self) -> int32 {
        unsafe { (*self.points.get()).len() as int32 }
    }

    unsafe fn getPoint(&self, index: int32, sampleOffset: *mut int32, value: *mut ParamValue) -> tresult {
        let points = unsafe { &*self.points.get() };
        match points.get(index as usize) {
            Some((offset, found)) if !sampleOffset.is_null() && !value.is_null() => {
                unsafe {
                    *sampleOffset = *offset;
                    *value = *found;
                }
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn addPoint(&self, sampleOffset: int32, value: ParamValue, index: *mut int32) -> tresult {
        let points = unsafe { &mut *self.points.get() };
        if points.len() == points.capacity() {
            return kResultFalse;
        }
        // Points must be in order of offset; a point at an offset already there replaces it.
        let at = points.iter().position(|(offset, _)| *offset >= sampleOffset).unwrap_or(points.len());
        if points.get(at).is_some_and(|(offset, _)| *offset == sampleOffset) {
            points[at].1 = value;
        } else {
            points.insert(at, (sampleOffset, value));
        }
        if !index.is_null() {
            unsafe { *index = at as int32 };
        }
        kResultOk
    }
}

/// Parameter changes for one process call: a fixed pool of queues, reused call after call.
pub struct ParameterChanges {
    queues: Vec<ComWrapper<ParamQueue>>,
    used: Cell<usize>,
}

impl ParameterChanges {
    pub fn new(queues: usize, points: usize) -> ComWrapper<ParameterChanges> {
        let queues = (0..queues).map(|_| ComWrapper::new(ParamQueue { id: Cell::new(0), points: UnsafeCell::new(Vec::with_capacity(points)) })).collect();
        ComWrapper::new(ParameterChanges { queues, used: Cell::new(0) })
    }

    pub fn clear(&self) {
        for queue in &self.queues[..self.used.get()] {
            unsafe { (*queue.points.get()).clear() };
        }
        self.used.set(0);
    }

    /// Adds a point for `id` (the queue of `id`, made on first use).
    pub fn add(&self, id: ParamID, offset: i32, value: f64) {
        let mut index = 0;
        let id_ref = id;
        unsafe {
            let queue = self.addParameterData(&id_ref, &mut index);
            if let Some(queue) = ComRef::<IParamValueQueue>::from_raw(queue) {
                let mut point = 0;
                queue.addPoint(offset, value, &mut point);
            }
        }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.used.get() == 0
    }
}

impl Class for ParameterChanges {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for ParameterChanges {
    unsafe fn getParameterCount(&self) -> int32 {
        self.used.get() as int32
    }

    unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
        if index < 0 || index as usize >= self.used.get() {
            return ptr::null_mut();
        }
        self.queues[index as usize].as_com_ref::<IParamValueQueue>().map_or(ptr::null_mut(), |queue| queue.as_ptr())
    }

    unsafe fn addParameterData(&self, id: *const ParamID, index: *mut int32) -> *mut IParamValueQueue {
        if id.is_null() {
            return ptr::null_mut();
        }
        let id = unsafe { *id };
        let used = self.used.get();
        let at = match self.queues[..used].iter().position(|queue| queue.id.get() == id) {
            Some(at) => at,
            None if used < self.queues.len() => {
                self.queues[used].id.set(id);
                unsafe { (*self.queues[used].points.get()).clear() };
                self.used.set(used + 1);
                used
            }
            None => return ptr::null_mut(),
        };
        if !index.is_null() {
            unsafe { *index = at as int32 };
        }
        self.queues[at].as_com_ref::<IParamValueQueue>().map_or(ptr::null_mut(), |queue| queue.as_ptr())
    }
}

/* ---------------------------------------------------------------- component handler */

/// What the plugin's controller tells the host: edits from its window (which the host must pass on to the audio
/// processor, VST3 has no other path), and restart requests.
pub struct ComponentHandler {
    pub edits: crossbeam_channel::Sender<(u32, f64)>,
    pub notifier: Notifier,
}

impl Class for ComponentHandler {
    type Interfaces = (IComponentHandler,);
}

impl IComponentHandlerTrait for ComponentHandler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }

    unsafe fn performEdit(&self, id: ParamID, valueNormalized: ParamValue) -> tresult {
        let _ = self.edits.try_send((id, valueNormalized));
        kResultOk
    }

    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        (self.notifier)(PluginNotice::StateDirty);
        kResultOk
    }

    unsafe fn restartComponent(&self, flags: int32) -> tresult {
        let flags = flags as u32;
        if flags & (RestartFlags_::kIoChanged as u32 | RestartFlags_::kReloadComponent as u32) != 0 {
            (self.notifier)(PluginNotice::RestartRequested);
        }
        if flags & RestartFlags_::kLatencyChanged as u32 != 0 {
            (self.notifier)(PluginNotice::LatencyChanged);
        }
        if flags & RestartFlags_::kParamValuesChanged as u32 != 0 {
            (self.notifier)(PluginNotice::StateDirty);
        }
        kResultOk
    }
}

/* ---------------------------------------------------------------- editor frame and run loop */

/// File descriptors and timers a Linux plugin editor registers (`IRunLoop`); served by the main loop.
#[derive(Default)]
pub struct RunLoop {
    #[cfg(target_os = "linux")]
    handlers: RefCell<Vec<(ComPtr<Linux::IEventHandler>, i32)>>,
    #[cfg(target_os = "linux")]
    timers: RefCell<Vec<(ComPtr<Linux::ITimerHandler>, Duration, Instant)>>,
}

impl RunLoop {
    /// Runs due timers and ready descriptors. Callbacks may (un)register: they run with nothing borrowed.
    pub fn tick(&self) {
        #[cfg(target_os = "linux")]
        {
            let now = Instant::now();
            let due: Vec<ComPtr<Linux::ITimerHandler>> = {
                let mut timers = self.timers.borrow_mut();
                timers
                    .iter_mut()
                    .filter(|(_, _, next)| *next <= now)
                    .map(|(handler, period, next)| {
                        *next = now + *period;
                        handler.clone()
                    })
                    .collect()
            };
            for handler in due {
                unsafe { handler.onTimer() };
            }
            let handlers: Vec<(ComPtr<Linux::IEventHandler>, i32)> = self.handlers.borrow().clone();
            if handlers.is_empty() {
                return;
            }
            let mut polled: Vec<libc::pollfd> = handlers.iter().map(|(_, fd)| libc::pollfd { fd: *fd, events: libc::POLLIN, revents: 0 }).collect();
            // SAFETY: a valid pollfd array; timeout 0.
            let ready = unsafe { libc::poll(polled.as_mut_ptr(), polled.len() as libc::nfds_t, 0) };
            if ready > 0 {
                for ((handler, fd), entry) in handlers.iter().zip(&polled) {
                    if entry.revents != 0 {
                        unsafe { handler.onFDIsSet(*fd) };
                    }
                }
            }
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct PlugFrame {
    pub notifier: Notifier,
    pub run_loop: std::rc::Rc<RunLoop>,
}

#[cfg(target_os = "linux")]
impl Class for PlugFrame {
    type Interfaces = (IPlugFrame, Linux::IRunLoop);
}

#[cfg(not(target_os = "linux"))]
impl Class for PlugFrame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for PlugFrame {
    unsafe fn resizeView(&self, view: *mut IPlugView, newSize: *mut ViewRect) -> tresult {
        if view.is_null() || newSize.is_null() {
            return kInvalidArgument;
        }
        let rect = unsafe { *newSize };
        let (width, height) = ((rect.right - rect.left).max(1) as u32, (rect.bottom - rect.top).max(1) as u32);
        (self.notifier)(PluginNotice::EditorResize { width, height });
        // The window follows on the main loop; the view learns its size now.
        if let Some(view) = unsafe { ComRef::<IPlugView>::from_raw(view) } {
            unsafe { view.onSize(newSize) };
        }
        kResultOk
    }
}

#[cfg(target_os = "linux")]
impl Linux::IRunLoopTrait for PlugFrame {
    unsafe fn registerEventHandler(&self, handler: *mut Linux::IEventHandler, fd: Linux::FileDescriptor) -> tresult {
        // The plugin lends the handler: keep a reference of our own.
        match unsafe { ComRef::<Linux::IEventHandler>::from_raw(handler) }.map(|handler| handler.to_com_ptr()) {
            Some(handler) => {
                self.run_loop.handlers.borrow_mut().push((handler, fd));
                kResultOk
            }
            None => kInvalidArgument,
        }
    }

    unsafe fn unregisterEventHandler(&self, handler: *mut Linux::IEventHandler) -> tresult {
        self.run_loop.handlers.borrow_mut().retain(|(known, _)| known.as_ptr() != handler);
        kResultOk
    }

    unsafe fn registerTimer(&self, handler: *mut Linux::ITimerHandler, milliseconds: Linux::TimerInterval) -> tresult {
        match unsafe { ComRef::<Linux::ITimerHandler>::from_raw(handler) }.map(|handler| handler.to_com_ptr()) {
            Some(handler) => {
                let period = Duration::from_millis(milliseconds.max(10));
                self.run_loop.timers.borrow_mut().push((handler, period, Instant::now() + period));
                kResultOk
            }
            None => kInvalidArgument,
        }
    }

    unsafe fn unregisterTimer(&self, handler: *mut Linux::ITimerHandler) -> tresult {
        self.run_loop.timers.borrow_mut().retain(|(known, _, _)| known.as_ptr() != handler);
        kResultOk
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_memory_stream_reads_what_was_written_and_seeks() {
        let stream = MemoryStream::new(Vec::new());
        let pointer = stream.to_com_ptr::<IBStream>().unwrap();
        let mut written = 0;
        let mut bytes = *b"hello";
        unsafe {
            pointer.write(bytes.as_mut_ptr() as *mut c_void, 5, &mut written);
            let mut position = 0;
            pointer.seek(1, IBStream_::IStreamSeekMode_::kIBSeekSet as int32, &mut position);
            assert_eq!(position, 1);
            let mut read = [0u8; 8];
            let mut count = 0;
            pointer.read(read.as_mut_ptr() as *mut c_void, 8, &mut count);
            assert_eq!(&read[..count as usize], b"ello");
        }
        assert_eq!(written, 5);
        assert_eq!(stream.take(), b"hello");
    }

    #[test]
    fn parameter_changes_keep_one_queue_per_parameter_and_ordered_points() {
        let changes = ParameterChanges::new(2, 4);
        changes.add(7, 100, 0.5);
        changes.add(7, 10, 0.1);
        changes.add(9, 0, 1.0);
        changes.add(11, 0, 1.0); // no room: dropped, not a crash
        let pointer = changes.to_com_ptr::<IParameterChanges>().unwrap();
        unsafe {
            assert_eq!(pointer.getParameterCount(), 2);
            let queue = ComRef::<IParamValueQueue>::from_raw(pointer.getParameterData(0)).unwrap();
            assert_eq!(queue.getParameterId(), 7);
            assert_eq!(queue.getPointCount(), 2);
            let (mut offset, mut value) = (0, 0.0);
            queue.getPoint(0, &mut offset, &mut value);
            assert_eq!((offset, value), (10, 0.1));
        }
        changes.clear();
        assert!(changes.is_empty());
    }

    #[test]
    fn the_host_hands_out_messages_with_attributes() {
        let host = ComWrapper::new(HostApplication);
        let pointer = host.to_com_ptr::<IHostApplication>().unwrap();
        let mut cid = IMessage::IID.map(|byte| byte as i8);
        let mut iid = cid;
        let mut object = ptr::null_mut();
        unsafe {
            assert_eq!(pointer.createInstance(&mut cid, &mut iid, &mut object), kResultOk);
            let message = ComPtr::<IMessage>::from_raw(object as *mut IMessage).unwrap();
            let id = CString::new("hello").unwrap();
            message.setMessageID(id.as_ptr());
            assert_eq!(CStr::from_ptr(message.getMessageID()).to_str().unwrap(), "hello");
            let attributes = ComRef::<IAttributeList>::from_raw(message.getAttributes()).unwrap();
            let name = CString::new("x").unwrap();
            attributes.setInt(name.as_ptr(), 42);
            let mut value = 0;
            attributes.getInt(name.as_ptr(), &mut value);
            assert_eq!(value, 42);
        }
    }
}
