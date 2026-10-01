//! The local server: one TCP port on 127.0.0.1 with
//!
//! * `GET /` — a status page with the pairing token (for the person at this computer),
//! * `/control` — WebSocket, JSON requests and events,
//! * `/audio` — WebSocket, binary audio frames.
//!
//! Every request must name this machine in its `Host` header (so a web page on a rebound DNS name cannot reach
//! it), WebSockets from a browser must come from an allowed origin, and every WebSocket must present the pairing
//! token before anything else.

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use tungstenite::handshake::server::{Request as HandshakeRequest, Response as HandshakeResponse};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

use crate::audio::AudioRegistry;
use crate::config::Config;
use crate::engine::MainHandle;
use crate::error::BridgeError;
use crate::plugin::{ProcessSetup, Transport};
use crate::protocol::{self, PROTOCOL_VERSION, Request, RequestEnvelope};
use crate::scan::Scanner;

/// What every connection thread needs.
#[derive(Clone)]
pub struct Shared {
    pub config: Arc<Config>,
    pub main: MainHandle,
    pub audio: AudioRegistry,
    pub scanner: Scanner,
    pub editors_available: bool,
    pub port: u16,
}

static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

/// Binds 127.0.0.1:`port` (only this computer can connect). Port 0 picks a free one (tests).
pub fn bind(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
}

/// Accepts connections until the listener fails; each gets its own thread.
pub fn serve(listener: TcpListener, shared: Shared) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let shared = shared.clone();
                let _ = thread::Builder::new().name("bridge-connection".into()).spawn(move || {
                    if let Err(error) = handle_connection(stream, &shared) {
                        log::debug!("connection ended: {error}");
                    }
                });
            }
            Err(error) => log::warn!("accept failed: {error}"),
        }
    }
}

/// A stream that first replays bytes already read (the HTTP head we inspected) and then continues with the socket.
struct Replay {
    head: Vec<u8>,
    at: usize,
    stream: TcpStream,
}

impl Read for Replay {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.at < self.head.len() {
            let count = buffer.len().min(self.head.len() - self.at);
            buffer[..count].copy_from_slice(&self.head[self.at..self.at + count]);
            self.at += count;
            return Ok(count);
        }
        self.stream.read(buffer)
    }
}

impl Write for Replay {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct HttpHead {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
}

impl HttpHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub fn is_websocket(&self) -> bool {
        self.header("upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    }
}

pub fn parse_head(bytes: &[u8]) -> Option<HttpHead> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_string();
    let path = request_line.next()?.to_string();
    let headers = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':').map(|(key, value)| (key.trim().to_string(), value.trim().to_string())))
        .collect();
    Some(HttpHead { method, path, headers })
}

/// Reads up to the end of the HTTP head (`\r\n\r\n`), at most 16 KiB.
fn read_head(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed before the request was complete"));
        }
        head.extend_from_slice(&buffer[..count]);
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(head);
        }
        if head.len() > 16 * 1024 || Instant::now() > deadline {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too long or too slow"));
        }
    }
}

/// `Host` must be this machine at our port: a page on a DNS name rebound to 127.0.0.1 sends its own name.
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    let host = host.to_ascii_lowercase();
    ["127.0.0.1", "localhost", "[::1]"].iter().any(|name| host == format!("{name}:{port}"))
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn handle_connection(mut stream: TcpStream, shared: &Shared) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let head_bytes = read_head(&mut stream)?;
    let Some(head) = parse_head(&head_bytes) else {
        return respond(&mut stream, "400 Bad Request", "text/plain", "Bad request");
    };
    if !host_allowed(head.header("host"), shared.port) {
        return respond(&mut stream, "403 Forbidden", "text/plain", "This bridge only answers requests addressed to 127.0.0.1 or localhost.");
    }
    let path = head.path.split('?').next().unwrap_or("");
    if !head.is_websocket() {
        return match (head.method.as_str(), path) {
            ("GET", "/") => {
                let page = status_page(shared);
                respond(&mut stream, "200 OK", "text/html; charset=utf-8", &page)
            }
            _ => respond(&mut stream, "404 Not Found", "text/plain", "Not found"),
        };
    }
    // A browser always sends its origin with a WebSocket; other local programs (tests, tools) may not.
    if let Some(origin) = head.header("origin") {
        if !shared.config.origin_allowed(origin) {
            log::warn!("refused a connection from {origin} (not in allowedOrigins)");
            return respond(
                &mut stream,
                "403 Forbidden",
                "text/plain",
                "This site is not allowed to use the bridge. Add it to allowedOrigins in the bridge's settings.",
            );
        }
    }
    let endpoint = match path {
        "/control" => Endpoint::Control,
        "/audio" => Endpoint::Audio,
        _ => return respond(&mut stream, "404 Not Found", "text/plain", "Not found"),
    };
    stream.set_read_timeout(None)?;
    stream.set_nodelay(true)?;
    let replay = Replay { head: head_bytes, at: 0, stream: stream.try_clone()? };
    let config = WebSocketConfig::default().max_message_size(Some(512 << 20)).max_frame_size(Some(512 << 20));
    #[allow(clippy::result_large_err)] // the callback's type is tungstenite's
    let accept = |_: &HandshakeRequest, response: HandshakeResponse| Ok(response);
    let socket = tungstenite::accept_hdr_with_config(replay, accept, Some(config)).map_err(|error| io::Error::other(error.to_string()))?;
    let result = match endpoint {
        Endpoint::Control => control_loop(socket, &stream, shared),
        Endpoint::Audio => audio_loop(socket, shared),
    };
    let _ = stream.shutdown(Shutdown::Both);
    result
}

enum Endpoint {
    Control,
    Audio,
}

fn ws_error(error: tungstenite::Error) -> io::Error {
    match error {
        tungstenite::Error::Io(error) => error,
        other => io::Error::other(other.to_string()),
    }
}

fn is_timeout(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
}

/// Checks the first message of a connection: `{"type":"hello","token":…}`. Returns the request id.
fn check_hello(text: &str, config: &Config) -> Result<u64, (u64, BridgeError)> {
    let envelope: RequestEnvelope = serde_json::from_str(text).map_err(|_| (0, BridgeError::unauthorized("Say hello with the pairing token first.")))?;
    match envelope.request {
        Request::Hello { token, protocol, .. } => {
            if !config.token_matches(&token) {
                return Err((envelope.id, BridgeError::unauthorized("The pairing token is wrong. Copy it from the bridge again.")));
            }
            if protocol != PROTOCOL_VERSION {
                return Err((
                    envelope.id,
                    BridgeError::new("protocol", format!("The bridge speaks protocol {PROTOCOL_VERSION}, the studio {protocol}. Update the older one.")),
                ));
            }
            Ok(envelope.id)
        }
        _ => Err((envelope.id, BridgeError::unauthorized("Say hello with the pairing token first."))),
    }
}

fn hello_result(shared: &Shared) -> serde_json::Value {
    serde_json::json!({
        "bridge": "juicyloops-bridge",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL_VERSION,
        "os": std::env::consts::OS,
        "formats": ["clap", "vst3"],
        "editors": shared.editors_available,
    })
}

/* ---------------------------------------------------------------- control */

fn control_loop(mut socket: WebSocket<Replay>, stream: &TcpStream, shared: &Shared) -> io::Result<()> {
    let owner = NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed);
    // The hello, within a few seconds.
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let first = socket.read().map_err(ws_error)?;
    let text = match first {
        Message::Text(text) => text.to_string(),
        _ => String::new(),
    };
    match check_hello(&text, &shared.config) {
        Ok(id) => {
            socket.send(Message::text(protocol::response(id, Ok(hello_result(shared))))).map_err(ws_error)?;
        }
        Err((id, error)) => {
            log::warn!("control connection refused: {}", error.message);
            let _ = socket.send(Message::text(protocol::response(id, Err(error))));
            let _ = socket.close(None);
            let _ = socket.flush();
            return Ok(());
        }
    }
    let (events, event_queue) = crossbeam_channel::unbounded::<String>();
    shared.main.run(move |engine, _| engine.subscribe(owner, events)).map_err(|error| io::Error::other(error.message))?;
    log::info!("studio connected (connection {owner})");

    // Poll: requests with a short timeout, events in between.
    stream.set_read_timeout(Some(Duration::from_millis(15)))?;
    let result = loop {
        let mut failed = None;
        while let Ok(event) = event_queue.try_recv() {
            if let Err(error) = socket.send(Message::text(event)) {
                failed = Some(error);
                break;
            }
        }
        if let Some(error) = failed {
            break Err(ws_error(error));
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let reply = handle_control(&text, owner, shared);
                if let Err(error) = socket.send(Message::text(reply)) {
                    break Err(ws_error(error));
                }
            }
            Ok(Message::Close(_)) => break Ok(()),
            Ok(_) => {}
            Err(error) if is_timeout(&error) => {
                let _ = socket.flush();
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => break Ok(()),
            Err(error) => break Err(ws_error(error)),
        }
    };
    let _ = shared.main.run(move |engine, windows| engine.unsubscribe(owner, windows));
    log::info!("studio disconnected (connection {owner})");
    result
}

pub fn handle_control(text: &str, owner: u64, shared: &Shared) -> String {
    let envelope: RequestEnvelope = match serde_json::from_str(text) {
        Ok(envelope) => envelope,
        Err(error) => {
            let id = serde_json::from_str::<serde_json::Value>(text).ok().and_then(|value| value["id"].as_u64()).unwrap_or(0);
            return protocol::response(id, Err(BridgeError::bad_request(format!("Not a request the bridge knows: {error}"))));
        }
    };
    let id = envelope.id;
    protocol::response(id, dispatch(envelope.request, owner, shared))
}

fn dispatch(request: Request, owner: u64, shared: &Shared) -> Result<serde_json::Value, BridgeError> {
    let main = &shared.main;
    let ok = || serde_json::json!({});
    match request {
        Request::Hello { .. } => Ok(hello_result(shared)),
        Request::Ping => Ok(serde_json::json!({ "pong": true })),
        Request::ListPlugins { rescan } => {
            if rescan {
                shared.scanner.rescan(main.clone());
            }
            main.run(|engine, _| engine.plugin_list_json())
        }
        Request::Create { plugin_id, sample_rate, max_block, input_channels, output_channels, state, mode } => {
            let chunk = match state {
                Some(state) if !state.is_empty() => Some(BASE64.decode(state.trim()).map_err(|_| BridgeError::bad_request("The state is not base64."))?),
                _ => None,
            };
            let setup = ProcessSetup { sample_rate, max_block, inputs: input_channels, outputs: output_channels, offline: false };
            main.run(move |engine, _| engine.create(owner, &plugin_id, setup, chunk.as_deref(), mode).map(|created| created.to_json()))?
        }
        Request::Destroy { instance } => main.run(move |engine, windows| engine.destroy(instance, windows).map(|_| ok()))?,
        Request::GetState { instance } => main.run(move |engine, _| engine.get_state(instance).map(|state| serde_json::json!({ "state": state })))?,
        Request::SetState { instance, state } => main.run(move |engine, _| engine.set_state(instance, &state).map(|_| ok()))?,
        Request::Params { instance } => main.run(move |engine, _| engine.params(instance))?,
        Request::SetParam { instance, param, value } => main.run(move |engine, _| engine.set_param(instance, param, value).map(|_| ok()))?,
        Request::OpenEditor { instance, title } => main.run(move |engine, windows| engine.open_editor(instance, title.as_deref(), windows).map(|_| ok()))?,
        Request::CloseEditor { instance } => main.run(move |engine, windows| engine.close_editor(instance, windows).map(|_| ok()))?,
        Request::Transport { instance, bpm, playing } => {
            let transport = Transport { bpm: bpm.clamp(1.0, 999.0), playing };
            main.run(move |engine, _| engine.set_transport(owner, instance, transport).map(|_| ok()))?
        }
        Request::Reset { instance } => main.run(move |engine, _| engine.reset(instance).map(|_| ok()))?,
    }
}

/* ---------------------------------------------------------------- audio */

fn audio_loop(mut socket: WebSocket<Replay>, shared: &Shared) -> io::Result<()> {
    let first = socket.read().map_err(ws_error)?;
    let text = match first {
        Message::Text(text) => text.to_string(),
        _ => String::new(),
    };
    match check_hello(&text, &shared.config) {
        Ok(id) => socket.send(Message::text(protocol::response(id, Ok(hello_result(shared))))).map_err(ws_error)?,
        Err((id, error)) => {
            let _ = socket.send(Message::text(protocol::response(id, Err(error))));
            let _ = socket.close(None);
            let _ = socket.flush();
            return Ok(());
        }
    }
    let mut worker = AudioWorker::new(shared.audio.clone());
    loop {
        match socket.read() {
            Ok(Message::Binary(bytes)) => match bytes.first().copied() {
                Some(protocol::KIND_PROCESS) => {
                    worker.process(&bytes);
                    socket.send(Message::binary(worker.reply.clone())).map_err(ws_error)?;
                }
                Some(protocol::KIND_RENDER) => {
                    let mut send_error = None;
                    worker.render(&bytes, |chunk| {
                        if send_error.is_none() {
                            if let Err(error) = socket.send(Message::binary(chunk.to_vec())) {
                                send_error = Some(error);
                            }
                        }
                    });
                    if let Some(error) = send_error {
                        return Err(ws_error(error));
                    }
                }
                _ => log::debug!("unknown audio frame"),
            },
            Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Ok(()),
            Ok(_) => {}
            Err(error) => return Err(ws_error(error)),
        }
    }
}

/// The per-connection audio state: decoding buffers reused block after block, so steady processing does not
/// allocate (the WebSocket library still makes one buffer per message).
pub struct AudioWorker {
    audio: AudioRegistry,
    events: Vec<crate::plugin::MidiEvent>,
    input: Vec<f32>,
    output: Vec<f32>,
    pub reply: Vec<u8>,
}

impl AudioWorker {
    pub fn new(audio: AudioRegistry) -> Self {
        Self {
            audio,
            events: Vec::with_capacity(256),
            input: Vec::with_capacity(2 * 8192),
            output: Vec::with_capacity(2 * 8192),
            reply: Vec::with_capacity(64 * 1024),
        }
    }

    /// Processes one `PROCESS` frame; the answer is left in `reply`.
    pub fn process(&mut self, bytes: &[u8]) {
        let started = Instant::now();
        let header = match protocol::decode_process(bytes, &mut self.events, &mut self.input) {
            Ok(header) => header,
            Err(_) => {
                let header = protocol::ProcessHeader {
                    instance: if bytes.len() >= 8 { u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) } else { 0 },
                    start_frame: 0.0,
                    frames: 0,
                    in_channels: 0,
                };
                protocol::encode_result(&mut self.reply, &header, protocol::STATUS_BAD_REQUEST, 0, 0, &[]);
                return;
            }
        };
        let Some(slot) = self.audio.get(header.instance) else {
            protocol::encode_result(&mut self.reply, &header, protocol::STATUS_NO_INSTANCE, 0, 0, &[]);
            return;
        };
        let mut slot = slot.lock().unwrap_or_else(|poison| poison.into_inner());
        let out_channels = slot.out_channels();
        let frames = header.frames as usize;
        self.output.clear();
        self.output.resize(out_channels as usize * frames, 0.0);
        let status = match slot.process_block(frames, header.in_channels as usize, &self.input, &self.events, &mut self.output) {
            Ok(()) => protocol::STATUS_OK,
            Err(error) if error.code == "not-found" => protocol::STATUS_NO_INSTANCE,
            Err(error) => {
                log::warn!("instance {}: {error}", header.instance);
                protocol::STATUS_PLUGIN_ERROR
            }
        };
        drop(slot);
        let micros = started.elapsed().as_micros().min(u32::MAX as u128) as u32;
        protocol::encode_result(&mut self.reply, &header, status, micros, out_channels, &self.output);
    }

    /// Runs one `RENDER` request, handing each encoded `RENDER_RESULT` chunk to `send`.
    pub fn render(&mut self, bytes: &[u8], mut send: impl FnMut(&[u8])) {
        let request = match protocol::decode_render(bytes) {
            Ok(request) => request,
            Err(error) => {
                let instance = if bytes.len() >= 8 { u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) } else { 0 };
                send(&protocol::encode_render_error(instance, &error.message));
                return;
            }
        };
        let Some(slot) = self.audio.get(request.instance) else {
            send(&protocol::encode_render_error(request.instance, "No such instance."));
            return;
        };
        let started = Instant::now();
        let mut slot = slot.lock().unwrap_or_else(|poison| poison.into_inner());
        let out_channels = slot.out_channels();
        let mut chunk_bytes = Vec::new();
        let result =
            slot.render(request.frames, request.in_channels as usize, &request.input, &request.events, request.chunk, |start, frames, output, last| {
                protocol::encode_render_result(
                    &mut chunk_bytes,
                    request.instance,
                    start,
                    frames,
                    if last { protocol::RENDER_LAST } else { 0 },
                    out_channels,
                    output,
                );
                send(&chunk_bytes);
                Ok(())
            });
        drop(slot);
        match result {
            Ok(()) => {
                let seconds = started.elapsed().as_secs_f64();
                log::info!("instance {}: rendered {} frames in {:.3} s", request.instance, request.frames, seconds);
            }
            Err(error) => send(&protocol::encode_render_error(request.instance, &error.message)),
        }
    }
}

/* ---------------------------------------------------------------- status page */

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn status_page(shared: &Shared) -> String {
    let (plugins, instances, scanning) = shared
        .main
        .run(|engine, _| {
            (engine.plugins().iter().filter(|plugin| plugin.format != crate::plugin::PluginFormat::Builtin).count(), engine.instance_count(), false)
        })
        .unwrap_or((0, 0, false));
    let _ = scanning;
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Juicy Loops Bridge</title>
<style>
:root{{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1b17;--muted:#6b665c;--card:#fff;--line:#e4e0d6;--accent:#e2572b}}
@media (prefers-color-scheme:dark){{:root{{--bg:#16140f;--fg:#f3efe6;--muted:#a59f92;--card:#211e18;--line:#353027}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}}
main{{max-width:40rem;margin:0 auto;padding:2.5rem 1rem}}
h1{{font-size:1.4rem;margin:0 0 .25rem}}p{{color:var(--muted);margin:.25rem 0 1rem}}
.token{{background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:1rem;font:600 1.35rem/1.3 ui-monospace,monospace;letter-spacing:.04em;user-select:all;word-break:break-all}}
dl{{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:1.5rem 0}}dt{{color:var(--muted)}}dd{{margin:0}}
b{{color:var(--accent)}}
</style></head><body><main>
<h1>Juicy Loops Bridge is running</h1>
<p>It plays the plugins installed on this computer for the Juicy Loops studio in your browser.</p>
<p>To pair the studio, open <b>Add plugin → Desktop plugins</b> there and paste this token:</p>
<div class="token">{token}</div>
<dl><dt>Address</dt><dd>ws://127.0.0.1:{port}</dd><dt>Plugins found</dt><dd>{plugins}</dd><dt>Running now</dt><dd>{instances}</dd><dt>Plugin windows</dt><dd>{windows}</dd><dt>Version</dt><dd>{version}</dd></dl>
<p>Keep the token to yourself: with it, a web page can play plugins on this computer.</p>
</main></body></html>"#,
        token = escape(&shared.config.token),
        port = shared.port,
        plugins = plugins,
        instances = instances,
        windows = if shared.editors_available { "yes" } else { "no (no display)" },
        version = env!("CARGO_PKG_VERSION"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heads_parse() {
        let head = parse_head(b"GET /control?x=1 HTTP/1.1\r\nHost: 127.0.0.1:47817\r\nUpgrade: websocket\r\nOrigin: http://localhost:5199\r\n\r\n").unwrap();
        assert_eq!(head.method, "GET");
        assert_eq!(head.path, "/control?x=1");
        assert_eq!(head.header("origin"), Some("http://localhost:5199"));
        assert!(head.is_websocket());
    }

    #[test]
    fn only_local_host_names_are_answered() {
        assert!(host_allowed(Some("127.0.0.1:47817"), 47817));
        assert!(host_allowed(Some("LOCALHOST:47817"), 47817));
        assert!(!host_allowed(Some("evil.example:47817"), 47817));
        assert!(!host_allowed(Some("127.0.0.1:1"), 47817));
        assert!(!host_allowed(None, 47817));
    }
}
