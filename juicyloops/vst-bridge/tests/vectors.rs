//! Golden binary frames shared with the studio's TypeScript tests (`frontend/src/juicyloops/__tests__/bridge.spec.ts`
//! reads the same files), so both sides of the protocol provably agree byte for byte.

use std::path::PathBuf;

use vst_bridge::plugin::MidiEvent;
use vst_bridge::protocol::{self, ProcessHeader};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn vectors() -> Vec<(&'static str, Vec<u8>)> {
    let left = [0.5f32, -0.25, 1.0];
    let right = [0.0f32, 0.125, -1.0];
    let process = protocol::encode_process(42, 4096.0, 3, &[MidiEvent::new(0, [0x90, 60, 100]), MidiEvent::new(2, [0x80, 60, 0])], &[&left, &right]);
    let mut result = Vec::new();
    protocol::encode_result(
        &mut result,
        &ProcessHeader { instance: 42, start_frame: 4096.0, frames: 3, in_channels: 2 },
        protocol::STATUS_OK,
        77,
        2,
        &[0.5, -0.25, 1.0, 0.0, 0.125, -1.0],
    );
    let render = protocol::encode_render(7, 96_000, &[MidiEvent::new(5, [0xe0, 0, 64]), MidiEvent::new(48_000, [0x90, 64, 90])], &[], 8);
    let mut chunk = Vec::new();
    protocol::encode_render_result(&mut chunk, 7, 4096, 2, protocol::RENDER_LAST, 2, &[0.25, 0.5, -0.25, -0.5]);
    vec![("process", process), ("result", result), ("render", render), ("render-result", chunk)]
}

#[test]
fn frames_match_the_shared_vectors() {
    for (name, bytes) in vectors() {
        let path = dir().join(format!("{name}.hex"));
        if std::env::var_os("WRITE_VECTORS").is_some() {
            std::fs::write(&path, hex(&bytes)).unwrap();
        }
        let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing {}; run with WRITE_VECTORS=1", path.display()));
        assert_eq!(hex(&bytes), expected.trim(), "{name}");
    }
}
