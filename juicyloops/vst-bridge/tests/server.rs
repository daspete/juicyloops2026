//! The bridge end to end over real sockets: pairing, origin and host checks, the control requests, live blocks
//! and the render mode, all with the built-in test plugins (no third-party plugin needed).

use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};
use vst_bridge::audio::AudioRegistry;
use vst_bridge::builtin;
use vst_bridge::config::{self, Config};
use vst_bridge::engine::{Engine, MainHandle, run_headless};
use vst_bridge::plugin::MidiEvent;
use vst_bridge::protocol;
use vst_bridge::scan::{ScanMethod, ScanSettings, Scanner};
use vst_bridge::server::{self, Shared};

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

struct Bridge {
    port: u16,
    token: String,
}

fn start() -> Bridge {
    let listener = server::bind(0).unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Config { token: config::new_token(), ..Config::default() };
    let token = config.token.clone();
    let (main, receiver) = MainHandle::new(Arc::new(|| {}));
    let audio = AudioRegistry::default();
    let engine_main = main.clone();
    let engine_audio = audio.clone();
    std::thread::spawn(move || {
        let mut engine = Engine::new(engine_main, engine_audio);
        engine.set_plugins(builtin::descriptions());
        run_headless(&mut engine, &receiver);
    });
    let settings = ScanSettings { clap: false, vst3: false, extra_paths: vec![], builtins: true, cache_file: None, method: ScanMethod::InProcess };
    let shared = Shared { config: Arc::new(config), main, audio, scanner: Scanner::new(settings), editors_available: false, port };
    std::thread::spawn(move || server::serve(listener, shared));
    Bridge { port, token }
}

fn connect(bridge: &Bridge, path: &str, origin: Option<&str>) -> Result<Socket, tungstenite::Error> {
    let mut request = format!("ws://127.0.0.1:{}{path}", bridge.port).into_client_request().unwrap();
    if let Some(origin) = origin {
        request.headers_mut().insert("Origin", HeaderValue::from_str(origin).unwrap());
    }
    let (socket, _) = tungstenite::connect(request)?;
    Ok(socket)
}

fn call(socket: &mut Socket, id: u64, request: Value) -> Value {
    let mut request = request;
    request["id"] = json!(id);
    socket.send(Message::text(request.to_string())).unwrap();
    loop {
        match socket.read().unwrap() {
            Message::Text(text) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["id"] == json!(id) {
                    return value;
                }
            }
            _ => continue,
        }
    }
}

fn paired(bridge: &Bridge, path: &str) -> Socket {
    let mut socket = connect(bridge, path, Some("http://127.0.0.1:5199")).unwrap();
    let hello = call(&mut socket, 1, json!({ "type": "hello", "token": bridge.token, "protocol": protocol::PROTOCOL_VERSION }));
    assert_eq!(hello["ok"], true, "{hello}");
    socket
}

#[test]
fn a_wrong_token_or_a_foreign_origin_gets_nothing() {
    let bridge = start();
    let mut socket = connect(&bridge, "/control", Some("http://localhost:5173")).unwrap();
    let answer = call(&mut socket, 1, json!({ "type": "hello", "token": "wrong", "protocol": 1 }));
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["error"]["code"], "unauthorized");

    let mut socket = connect(&bridge, "/control", None).unwrap();
    let answer = call(&mut socket, 1, json!({ "type": "listPlugins" }));
    assert_eq!(answer["error"]["code"], "unauthorized", "no hello, no list");

    assert!(connect(&bridge, "/control", Some("https://evil.example")).is_err(), "foreign origin refused at the handshake");

    // A DNS-rebound name: the request reaches 127.0.0.1 but names another host.
    use std::io::{Read, Write};
    let mut raw = TcpStream::connect(("127.0.0.1", bridge.port)).unwrap();
    raw.write_all(b"GET / HTTP/1.1\r\nHost: rebound.example:1234\r\n\r\n").unwrap();
    let mut reply = String::new();
    raw.read_to_string(&mut reply).unwrap();
    assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");

    let mut raw = TcpStream::connect(("127.0.0.1", bridge.port)).unwrap();
    raw.write_all(format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", bridge.port).as_bytes()).unwrap();
    let mut reply = String::new();
    raw.read_to_string(&mut reply).unwrap();
    assert!(reply.starts_with("HTTP/1.1 200") && reply.contains(&bridge.token), "the status page shows the token");
}

#[test]
fn an_instrument_plays_live_blocks_and_renders_offline() {
    let bridge = start();
    let mut control = paired(&bridge, "/control");
    let list = call(&mut control, 2, json!({ "type": "listPlugins" }));
    let plugins = list["result"]["plugins"].as_array().unwrap();
    assert!(plugins.iter().any(|plugin| plugin["id"] == builtin::SYNTH_ID && plugin["kind"] == "instrument"));

    let created = call(&mut control, 3, json!({ "type": "create", "pluginId": builtin::SYNTH_ID, "sampleRate": 48000, "maxBlock": 128 }));
    assert_eq!(created["ok"], true, "{created}");
    let instance = created["result"]["instance"].as_u64().unwrap() as u32;
    assert_eq!(created["result"]["outputChannels"], 2);

    let mut audio = paired(&bridge, "/audio");
    // Block 0: a note at frame 64 of a 256-frame block (split into two 128-frame plugin blocks by the bridge).
    let request = protocol::encode_process(instance, 0.0, 256, &[MidiEvent::new(64, [0x90, 69, 127])], &[]);
    let mut latencies = Vec::new();
    let mut output = Vec::new();
    for block in 0..200 {
        let start = std::time::Instant::now();
        let bytes = if block == 0 { request.clone() } else { protocol::encode_process(instance, block as f64 * 256.0, 256, &[], &[]) };
        audio.send(Message::binary(bytes)).unwrap();
        let reply = loop {
            if let Message::Binary(reply) = audio.read().unwrap() {
                break reply;
            }
        };
        latencies.push(start.elapsed());
        let header = protocol::decode_result(&reply, &mut output).unwrap();
        assert_eq!(header.status, protocol::STATUS_OK);
        assert_eq!(header.start_frame, block as f64 * 256.0);
        if block == 0 {
            assert!(output[..65].iter().all(|sample| *sample == 0.0));
            assert!(output[65..256].iter().any(|sample| sample.abs() > 0.05));
            assert_eq!(output[..256], output[256..], "both sides");
        }
    }
    latencies.sort();
    let median = latencies[latencies.len() / 2];
    let worst = latencies[latencies.len() - 1];
    println!("round trip of a 256-frame block: median {median:?}, worst {worst:?}");
    assert!(median < Duration::from_millis(20));

    // Render mode: two seconds with a note in the middle, in 8 Ki chunks.
    let frames = 96_000u64;
    let events = [MidiEvent::new(48_000, [0x90, 60, 100]), MidiEvent::new(72_000, [0x80, 60, 0])];
    audio.send(Message::binary(protocol::encode_render(instance, frames, &events, &[], 8))).unwrap();
    let mut rendered = vec![0.0f32; frames as usize];
    let started = std::time::Instant::now();
    loop {
        let Message::Binary(bytes) = audio.read().unwrap() else { continue };
        let chunk = protocol::decode_render_result(&bytes).unwrap();
        assert!(chunk.error.is_none(), "{:?}", chunk.error);
        rendered[chunk.start_frame as usize..chunk.start_frame as usize + chunk.frames as usize].copy_from_slice(&chunk.output[..chunk.frames as usize]);
        if chunk.last {
            break;
        }
    }
    println!("rendered 2 s in {:?}", started.elapsed());
    assert!(rendered[..48_001].iter().all(|sample| *sample == 0.0), "the live note was reset before the render");
    assert!(rendered[48_001..72_000].iter().any(|sample| sample.abs() > 0.05));
    assert!(rendered[80_000..].iter().all(|sample| *sample == 0.0), "released after 50 ms");

    // A block for an instance that is gone.
    let destroyed = call(&mut control, 4, json!({ "type": "destroy", "instance": instance }));
    assert_eq!(destroyed["ok"], true);
    audio.send(Message::binary(protocol::encode_process(instance, 0.0, 128, &[], &[]))).unwrap();
    let reply = loop {
        if let Message::Binary(reply) = audio.read().unwrap() {
            break reply;
        }
    };
    assert_eq!(protocol::decode_result(&reply, &mut output).unwrap().status, protocol::STATUS_NO_INSTANCE);
}

#[test]
fn an_effect_processes_input_and_its_state_moves_between_instances() {
    let bridge = start();
    let mut control = paired(&bridge, "/control");
    let created = call(&mut control, 2, json!({ "type": "create", "pluginId": builtin::GAIN_ID, "sampleRate": 44100, "inputChannels": 2 }));
    let instance = created["result"]["instance"].as_u64().unwrap();
    assert_eq!(call(&mut control, 3, json!({ "type": "setParam", "instance": instance, "param": 0, "value": 0.25 }))["ok"], true);
    let params = call(&mut control, 4, json!({ "type": "params", "instance": instance }));
    assert_eq!(params["result"]["params"][0]["value"], 0.25);
    let state = call(&mut control, 5, json!({ "type": "getState", "instance": instance }))["result"]["state"].as_str().unwrap().to_string();

    let copy = call(
        &mut control,
        6,
        json!({ "type": "create", "pluginId": builtin::GAIN_ID, "sampleRate": 44100, "inputChannels": 2, "state": state, "mode": "offline" }),
    );
    let copy = copy["result"]["instance"].as_u64().unwrap() as u32;
    let mut audio = paired(&bridge, "/audio");
    let left = [1.0f32, 0.5, -0.5, 0.0];
    let right = [0.0f32, 1.0, 1.0, -1.0];
    audio.send(Message::binary(protocol::encode_process(copy, 0.0, 4, &[], &[&left, &right]))).unwrap();
    let reply = loop {
        if let Message::Binary(reply) = audio.read().unwrap() {
            break reply;
        }
    };
    let mut output = Vec::new();
    protocol::decode_result(&reply, &mut output).unwrap();
    assert_eq!(output, vec![0.25, 0.125, -0.125, 0.0, 0.0, 0.25, 0.25, -0.25]);

    // The editor needs a display the test does not have: a clear error, not a hang.
    let editor = call(&mut control, 7, json!({ "type": "openEditor", "instance": copy }));
    assert_eq!(editor["ok"], false);

    // Closing the control connection closes its instances.
    drop(control);
    std::thread::sleep(Duration::from_millis(200));
    audio.send(Message::binary(protocol::encode_process(copy, 0.0, 4, &[], &[&left, &right]))).unwrap();
    let reply = loop {
        if let Message::Binary(reply) = audio.read().unwrap() {
            break reply;
        }
    };
    assert_eq!(protocol::decode_result(&reply, &mut output).unwrap().status, protocol::STATUS_NO_INSTANCE);
}
