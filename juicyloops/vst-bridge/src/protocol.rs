//! The wire protocol between the studio and the bridge (see `PROTOCOL.md`).
//!
//! Two WebSocket endpoints on one port: `/control` carries JSON requests, responses and events (text frames);
//! `/audio` carries audio as binary frames, laid out here. All numbers little-endian, audio planar f32.

use serde::{Deserialize, Serialize};

use crate::error::BridgeError;
use crate::plugin::MidiEvent;

/// Bumped on any incompatible change; the studio refuses a bridge that speaks another version.
pub const PROTOCOL_VERSION: u32 = 1;

/* ---------------------------------------------------------------- control (JSON) */

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub id: u64,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum InstanceMode {
    /// Driven block by block in real time by the studio's audio node.
    #[default]
    Live,
    /// Used by an export: rendered as fast as possible.
    Offline,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// First message on every connection.
    Hello {
        token: String,
        #[serde(default)]
        protocol: u32,
        #[serde(default)]
        client: String,
    },
    Ping,
    ListPlugins {
        #[serde(default)]
        rescan: bool,
    },
    Create {
        plugin_id: String,
        sample_rate: f64,
        #[serde(default = "default_max_block")]
        max_block: u32,
        #[serde(default)]
        input_channels: u32,
        #[serde(default = "default_outputs")]
        output_channels: u32,
        /// The plugin's state chunk, base64.
        #[serde(default)]
        state: Option<String>,
        #[serde(default)]
        mode: InstanceMode,
    },
    Destroy {
        instance: u32,
    },
    GetState {
        instance: u32,
    },
    SetState {
        instance: u32,
        state: String,
    },
    Params {
        instance: u32,
    },
    SetParam {
        instance: u32,
        param: u32,
        value: f64,
    },
    OpenEditor {
        instance: u32,
        #[serde(default)]
        title: Option<String>,
    },
    CloseEditor {
        instance: u32,
    },
    /// Tempo and play state for one instance, or for all of this connection's (`instance` absent).
    Transport {
        #[serde(default)]
        instance: Option<u32>,
        bpm: f64,
        #[serde(default)]
        playing: bool,
    },
    Reset {
        instance: u32,
    },
}

fn default_max_block() -> u32 {
    1024
}

fn default_outputs() -> u32 {
    2
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl From<&BridgeError> for ErrorBody {
    fn from(error: &BridgeError) -> Self {
        Self { code: error.code.to_string(), message: error.message.clone() }
    }
}

/// The answer to a request: `{"id":1,"ok":true,"result":…}` or `{"id":1,"ok":false,"error":{code,message}}`.
pub fn response(id: u64, result: Result<serde_json::Value, BridgeError>) -> String {
    let value = match result {
        Ok(result) => serde_json::json!({ "id": id, "ok": true, "result": result }),
        Err(error) => serde_json::json!({ "id": id, "ok": false, "error": ErrorBody::from(&error) }),
    };
    value.to_string()
}

/// Something the bridge tells the studio unasked.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerEvent {
    /// The plugin's window was closed on the desktop.
    EditorClosed { instance: u32 },
    /// The plugin's state changed (e.g. a knob turned in its window).
    StateChanged { instance: u32 },
    /// The plugin's latency changed.
    LatencyChanged { instance: u32, latency: u32 },
    /// A rescan finished: the list may differ.
    PluginsChanged,
}

impl ServerEvent {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn instance(&self) -> Option<u32> {
        match self {
            ServerEvent::EditorClosed { instance } | ServerEvent::StateChanged { instance } | ServerEvent::LatencyChanged { instance, .. } => Some(*instance),
            ServerEvent::PluginsChanged => None,
        }
    }
}

/* ---------------------------------------------------------------- audio (binary) */

/// Studio → bridge: one block to process (with input audio for an effect).
pub const KIND_PROCESS: u8 = 1;
/// Bridge → studio: the processed block.
pub const KIND_RESULT: u8 = 2;
/// Studio → bridge: render a whole range as fast as possible (offline export).
pub const KIND_RENDER: u8 = 3;
/// Bridge → studio: one chunk of a render.
pub const KIND_RENDER_RESULT: u8 = 4;

pub const HEADER_SIZE: usize = 24;
pub const EVENT_SIZE: usize = 8;

/// `RESULT` status values.
pub const STATUS_OK: u16 = 0;
pub const STATUS_NO_INSTANCE: u16 = 1;
pub const STATUS_PLUGIN_ERROR: u16 = 2;
pub const STATUS_BAD_REQUEST: u16 = 3;

/// `RENDER_RESULT` flags.
pub const RENDER_LAST: u32 = 1;
pub const RENDER_ERROR: u32 = 2;

/// Most frames one `PROCESS` block may carry.
pub const MAX_PROCESS_FRAMES: usize = 16_384;
/// Most channels either way.
pub const MAX_CHANNELS: usize = 2;

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn f64_at(bytes: &[u8], at: usize) -> f64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[at..at + 8]);
    f64::from_le_bytes(raw)
}

/// Reads planar little-endian f32 into `into` (resized without shrinking its capacity).
fn read_f32s(bytes: &[u8], into: &mut Vec<f32>) {
    into.clear();
    into.extend(bytes.chunks_exact(4).map(|raw| f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])));
}

/// A decoded `PROCESS` frame. `events` and `input` live in caller-owned buffers, reused frame after frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProcessHeader {
    pub instance: u32,
    pub start_frame: f64,
    pub frames: u32,
    pub in_channels: u32,
}

/// Layout of `PROCESS`:
///
/// | at | size | field |
/// |---|---|---|
/// | 0 | u8 | kind = 1 |
/// | 1 | u8 | input channels (0..2) |
/// | 2 | u16 | frames |
/// | 4 | u32 | instance |
/// | 8 | f64 | start frame (the block's position on the studio's timeline) |
/// | 16 | u16 | event count |
/// | 18 | u16 | reserved |
/// | 20 | u32 | reserved |
/// | 24 | 8 × events | u16 frame offset in the block, u8 byte count, 3 MIDI bytes, u16 reserved |
/// | … | f32 × channels × frames | input, planar |
pub fn decode_process(bytes: &[u8], events: &mut Vec<MidiEvent>, input: &mut Vec<f32>) -> Result<ProcessHeader, BridgeError> {
    if bytes.len() < HEADER_SIZE || bytes[0] != KIND_PROCESS {
        return Err(BridgeError::bad_request("Not a process frame."));
    }
    let in_channels = bytes[1] as usize;
    let frames = u16_at(bytes, 2) as usize;
    let count = u16_at(bytes, 16) as usize;
    if in_channels > MAX_CHANNELS || frames == 0 || frames > MAX_PROCESS_FRAMES {
        return Err(BridgeError::bad_request("Bad channel or frame count."));
    }
    let audio_at = HEADER_SIZE + count * EVENT_SIZE;
    if bytes.len() != audio_at + in_channels * frames * 4 {
        return Err(BridgeError::bad_request("The frame's length does not match its header."));
    }
    events.clear();
    for index in 0..count {
        let at = HEADER_SIZE + index * EVENT_SIZE;
        let offset = u16_at(bytes, at) as u32;
        if offset as usize >= frames {
            return Err(BridgeError::bad_request("An event lies outside its block."));
        }
        let size = bytes[at + 2].min(3) as usize;
        let mut midi = [0u8; 3];
        midi[..size].copy_from_slice(&bytes[at + 3..at + 3 + size]);
        events.push(MidiEvent::new(offset, midi));
    }
    // Stable sort: events at one frame keep their order (a note-off before the next note-on).
    events.sort_by_key(|event| event.frame);
    read_f32s(&bytes[audio_at..], input);
    Ok(ProcessHeader { instance: u32_at(bytes, 4), start_frame: f64_at(bytes, 8), frames: frames as u32, in_channels: in_channels as u32 })
}

/// Builds a `PROCESS` frame (the studio does this in TypeScript; here for tests and tools).
pub fn encode_process(instance: u32, start_frame: f64, frames: u32, events: &[MidiEvent], input: &[&[f32]]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_SIZE + events.len() * EVENT_SIZE + input.len() * frames as usize * 4);
    bytes.push(KIND_PROCESS);
    bytes.push(input.len() as u8);
    bytes.extend_from_slice(&(frames as u16).to_le_bytes());
    bytes.extend_from_slice(&instance.to_le_bytes());
    bytes.extend_from_slice(&start_frame.to_le_bytes());
    bytes.extend_from_slice(&(events.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&[0; 6]);
    for event in events {
        bytes.extend_from_slice(&(event.frame as u16).to_le_bytes());
        bytes.push(3);
        bytes.extend_from_slice(&event.bytes);
        bytes.extend_from_slice(&[0; 2]);
    }
    for channel in input {
        for sample in channel.iter().take(frames as usize) {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
    }
    bytes
}

/// Layout of `RESULT`:
///
/// | at | size | field |
/// |---|---|---|
/// | 0 | u8 | kind = 2 |
/// | 1 | u8 | output channels |
/// | 2 | u16 | frames |
/// | 4 | u32 | instance |
/// | 8 | f64 | start frame (echoed) |
/// | 16 | u16 | status (0 ok, 1 no such instance, 2 plugin error, 3 bad request) |
/// | 18 | u16 | reserved |
/// | 20 | u32 | microseconds the bridge spent on the block |
/// | 24 | f32 × channels × frames | output, planar (absent unless status is 0) |
pub fn encode_result(into: &mut Vec<u8>, header: &ProcessHeader, status: u16, micros: u32, out_channels: u32, output: &[f32]) {
    into.clear();
    let ok = status == STATUS_OK;
    into.push(KIND_RESULT);
    into.push(if ok { out_channels as u8 } else { 0 });
    into.extend_from_slice(&(header.frames as u16).to_le_bytes());
    into.extend_from_slice(&header.instance.to_le_bytes());
    into.extend_from_slice(&header.start_frame.to_le_bytes());
    into.extend_from_slice(&status.to_le_bytes());
    into.extend_from_slice(&[0; 2]);
    into.extend_from_slice(&micros.to_le_bytes());
    if ok {
        for sample in output {
            into.extend_from_slice(&sample.to_le_bytes());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResultHeader {
    pub instance: u32,
    pub start_frame: f64,
    pub frames: u32,
    pub out_channels: u32,
    pub status: u16,
    pub micros: u32,
}

/// Reads a `RESULT` frame; the output lands in `output` (planar).
pub fn decode_result(bytes: &[u8], output: &mut Vec<f32>) -> Result<ResultHeader, BridgeError> {
    if bytes.len() < HEADER_SIZE || bytes[0] != KIND_RESULT {
        return Err(BridgeError::bad_request("Not a result frame."));
    }
    let header = ResultHeader {
        instance: u32_at(bytes, 4),
        start_frame: f64_at(bytes, 8),
        frames: u16_at(bytes, 2) as u32,
        out_channels: bytes[1] as u32,
        status: u16_at(bytes, 16),
        micros: u32_at(bytes, 20),
    };
    read_f32s(&bytes[HEADER_SIZE..], output);
    Ok(header)
}

/// A decoded `RENDER` request.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderRequest {
    pub instance: u32,
    pub frames: u64,
    pub in_channels: u32,
    /// Events at absolute frames of the render, sorted.
    pub events: Vec<MidiEvent>,
    /// Planar input (`in_channels × frames`), empty for an instrument.
    pub input: Vec<f32>,
    /// Frames per `RENDER_RESULT` chunk.
    pub chunk: u32,
}

/// Layout of `RENDER`:
///
/// | at | size | field |
/// |---|---|---|
/// | 0 | u8 | kind = 3 |
/// | 1 | u8 | input channels |
/// | 2 | u16 | chunk size in 1024-frame units (0 = default, 64 Ki frames) |
/// | 4 | u32 | instance |
/// | 8 | f64 | frames to render |
/// | 16 | u32 | event count |
/// | 20 | u32 | reserved |
/// | 24 | 8 × events | u32 absolute frame, 3 MIDI bytes, u8 byte count |
/// | … | f32 × channels × frames | input, planar |
pub fn decode_render(bytes: &[u8]) -> Result<RenderRequest, BridgeError> {
    if bytes.len() < HEADER_SIZE || bytes[0] != KIND_RENDER {
        return Err(BridgeError::bad_request("Not a render frame."));
    }
    let in_channels = bytes[1] as usize;
    let chunk_units = u16_at(bytes, 2) as u32;
    let frames = f64_at(bytes, 8);
    let count = u32_at(bytes, 16) as usize;
    if in_channels > MAX_CHANNELS || !(1.0..=48_000.0 * 60.0 * 60.0 * 4.0).contains(&frames) || frames.fract() != 0.0 {
        return Err(BridgeError::bad_request("Bad channel or frame count."));
    }
    let frames = frames as u64;
    let audio_at = HEADER_SIZE.checked_add(count.checked_mul(EVENT_SIZE).ok_or_else(|| BridgeError::bad_request("Too many events."))?);
    let audio_at = audio_at.ok_or_else(|| BridgeError::bad_request("Too many events."))?;
    if bytes.len() as u64 != audio_at as u64 + in_channels as u64 * frames * 4 {
        return Err(BridgeError::bad_request("The frame's length does not match its header."));
    }
    let mut events = Vec::with_capacity(count);
    for index in 0..count {
        let at = HEADER_SIZE + index * EVENT_SIZE;
        let frame = u32_at(bytes, at);
        if frame as u64 >= frames {
            continue;
        }
        let size = bytes[at + 7].min(3) as usize;
        let mut midi = [0u8; 3];
        midi[..size].copy_from_slice(&bytes[at + 4..at + 4 + size]);
        events.push(MidiEvent::new(frame, midi));
    }
    events.sort_by_key(|event| event.frame);
    let mut input = Vec::new();
    read_f32s(&bytes[audio_at..], &mut input);
    Ok(RenderRequest {
        instance: u32_at(bytes, 4),
        frames,
        in_channels: in_channels as u32,
        events,
        input,
        chunk: if chunk_units == 0 { 65_536 } else { chunk_units * 1024 },
    })
}

pub fn encode_render(instance: u32, frames: u64, events: &[MidiEvent], input: &[&[f32]], chunk_units: u16) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.push(KIND_RENDER);
    bytes.push(input.len() as u8);
    bytes.extend_from_slice(&chunk_units.to_le_bytes());
    bytes.extend_from_slice(&instance.to_le_bytes());
    bytes.extend_from_slice(&(frames as f64).to_le_bytes());
    bytes.extend_from_slice(&(events.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&[0; 4]);
    for event in events {
        bytes.extend_from_slice(&event.frame.to_le_bytes());
        bytes.extend_from_slice(&event.bytes);
        bytes.push(3);
    }
    for channel in input {
        for sample in channel.iter().take(frames as usize) {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
    }
    bytes
}

/// Layout of `RENDER_RESULT`:
///
/// | at | size | field |
/// |---|---|---|
/// | 0 | u8 | kind = 4 |
/// | 1 | u8 | output channels |
/// | 2 | u16 | reserved |
/// | 4 | u32 | instance |
/// | 8 | f64 | the chunk's first frame |
/// | 16 | u32 | frames in this chunk |
/// | 20 | u32 | flags: 1 = last chunk, 2 = error (the payload is then a UTF-8 message) |
/// | 24 | f32 × channels × frames | output, planar |
pub fn encode_render_result(into: &mut Vec<u8>, instance: u32, start_frame: u64, frames: u32, flags: u32, out_channels: u32, payload: &[f32]) {
    into.clear();
    into.push(KIND_RENDER_RESULT);
    into.push(out_channels as u8);
    into.extend_from_slice(&[0; 2]);
    into.extend_from_slice(&instance.to_le_bytes());
    into.extend_from_slice(&(start_frame as f64).to_le_bytes());
    into.extend_from_slice(&frames.to_le_bytes());
    into.extend_from_slice(&flags.to_le_bytes());
    for sample in payload {
        into.extend_from_slice(&sample.to_le_bytes());
    }
}

pub fn encode_render_error(instance: u32, message: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    encode_render_result(&mut bytes, instance, 0, 0, RENDER_LAST | RENDER_ERROR, 0, &[]);
    bytes.extend_from_slice(message.as_bytes());
    bytes
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderChunk {
    pub instance: u32,
    pub start_frame: u64,
    pub frames: u32,
    pub out_channels: u32,
    pub last: bool,
    pub error: Option<String>,
    pub output: Vec<f32>,
}

pub fn decode_render_result(bytes: &[u8]) -> Result<RenderChunk, BridgeError> {
    if bytes.len() < HEADER_SIZE || bytes[0] != KIND_RENDER_RESULT {
        return Err(BridgeError::bad_request("Not a render result frame."));
    }
    let flags = u32_at(bytes, 20);
    let mut output = Vec::new();
    let error = if flags & RENDER_ERROR != 0 {
        Some(String::from_utf8_lossy(&bytes[HEADER_SIZE..]).into_owned())
    } else {
        read_f32s(&bytes[HEADER_SIZE..], &mut output);
        None
    };
    Ok(RenderChunk {
        instance: u32_at(bytes, 4),
        start_frame: f64_at(bytes, 8) as u64,
        frames: u32_at(bytes, 16),
        out_channels: bytes[1] as u32,
        last: flags & RENDER_LAST != 0,
        error,
        output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse_from_the_studio_json() {
        let envelope: RequestEnvelope =
            serde_json::from_str(r#"{"id":7,"type":"create","pluginId":"clap:org.x","sampleRate":48000,"inputChannels":2,"state":"AAEC"}"#).unwrap();
        assert_eq!(envelope.id, 7);
        assert_eq!(
            envelope.request,
            Request::Create {
                plugin_id: "clap:org.x".into(),
                sample_rate: 48000.0,
                max_block: 1024,
                input_channels: 2,
                output_channels: 2,
                state: Some("AAEC".into()),
                mode: InstanceMode::Live
            }
        );
        let hello: RequestEnvelope = serde_json::from_str(r#"{"id":1,"type":"hello","token":"abc","protocol":1}"#).unwrap();
        assert!(matches!(hello.request, Request::Hello { ref token, protocol: 1, .. } if token == "abc"));
        let transport: RequestEnvelope = serde_json::from_str(r#"{"id":2,"type":"transport","bpm":98.5,"playing":true}"#).unwrap();
        assert_eq!(transport.request, Request::Transport { instance: None, bpm: 98.5, playing: true });
        assert!(serde_json::from_str::<RequestEnvelope>(r#"{"id":3,"type":"launchMissiles"}"#).is_err());
    }

    #[test]
    fn responses_and_events_serialize() {
        assert_eq!(response(3, Ok(serde_json::json!({"a":1}))), r#"{"id":3,"ok":true,"result":{"a":1}}"#);
        assert_eq!(
            response(4, Err(BridgeError::not_found("No such plugin."))),
            r#"{"error":{"code":"not-found","message":"No such plugin."},"id":4,"ok":false}"#
        );
        assert_eq!(ServerEvent::EditorClosed { instance: 9 }.to_json(), r#"{"event":"editorClosed","instance":9}"#);
    }

    #[test]
    fn process_frames_round_trip() {
        let left = [0.5f32, -0.25, 1.0];
        let right = [0.0f32, 0.125, -1.0];
        let events = [MidiEvent::new(2, [0x80, 60, 0]), MidiEvent::new(0, [0x90, 60, 100])];
        let bytes = encode_process(42, 4096.0, 3, &events, &[&left, &right]);
        let mut decoded_events = Vec::new();
        let mut input = Vec::new();
        let header = decode_process(&bytes, &mut decoded_events, &mut input).unwrap();
        assert_eq!(header, ProcessHeader { instance: 42, start_frame: 4096.0, frames: 3, in_channels: 2 });
        assert_eq!(decoded_events, vec![MidiEvent::new(0, [0x90, 60, 100]), MidiEvent::new(2, [0x80, 60, 0])]);
        assert_eq!(input, vec![0.5, -0.25, 1.0, 0.0, 0.125, -1.0]);

        let mut result = Vec::new();
        encode_result(&mut result, &header, STATUS_OK, 77, 2, &input);
        let mut output = Vec::new();
        let decoded = decode_result(&result, &mut output).unwrap();
        assert_eq!((decoded.instance, decoded.start_frame, decoded.frames, decoded.out_channels, decoded.status, decoded.micros), (42, 4096.0, 3, 2, 0, 77));
        assert_eq!(output, input);
    }

    #[test]
    fn broken_process_frames_are_refused() {
        let mut events = Vec::new();
        let mut input = Vec::new();
        let good = encode_process(1, 0.0, 4, &[MidiEvent::new(1, [0x90, 1, 1])], &[&[0.0; 4]]);
        assert!(decode_process(&good[..good.len() - 1], &mut events, &mut input).is_err(), "short");
        let mut outside = good.clone();
        outside[24] = 9; // event offset 9 in a 4-frame block
        assert!(decode_process(&outside, &mut events, &mut input).is_err(), "event outside");
        let mut channels = good.clone();
        channels[1] = 3;
        assert!(decode_process(&channels, &mut events, &mut input).is_err(), "three channels");
        assert!(decode_process(&[KIND_RESULT; 24], &mut events, &mut input).is_err(), "wrong kind");
    }

    #[test]
    fn render_frames_round_trip() {
        let events = [MidiEvent::new(100_000, [0x90, 64, 90]), MidiEvent::new(5, [0xe0, 0, 64])];
        let bytes = encode_render(3, 200_000, &events, &[], 4);
        let request = decode_render(&bytes).unwrap();
        assert_eq!(request.instance, 3);
        assert_eq!(request.frames, 200_000);
        assert_eq!(request.chunk, 4096);
        assert_eq!(request.events, vec![MidiEvent::new(5, [0xe0, 0, 64]), MidiEvent::new(100_000, [0x90, 64, 90])]);

        let mut chunk = Vec::new();
        encode_render_result(&mut chunk, 3, 4096, 2, RENDER_LAST, 1, &[0.25, 0.5]);
        let decoded = decode_render_result(&chunk).unwrap();
        assert_eq!((decoded.start_frame, decoded.frames, decoded.last, decoded.output.clone()), (4096, 2, true, vec![0.25, 0.5]));
        let error = decode_render_result(&encode_render_error(3, "boom")).unwrap();
        assert_eq!(error.error.as_deref(), Some("boom"));
    }
}
