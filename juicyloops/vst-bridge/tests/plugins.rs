//! Real plugin files through the real hosts: Clack's example CLAP plugins and two small open-source VST3 plugins,
//! built by `scripts/fixtures.sh`. Skipped (with a note) when the fixtures are not built.

use std::path::PathBuf;
use std::sync::Arc;

use vst_bridge::audio::AudioRegistry;
use vst_bridge::engine::{Engine, MainHandle, NoWindows};
use vst_bridge::plugin::{MidiEvent, PluginDescription, PluginFormat, PluginKind, ProcessSetup};
use vst_bridge::protocol::InstanceMode;
use vst_bridge::scan::{self, ScanMethod, ScanSettings};

fn fixtures() -> Option<PathBuf> {
    let dir = std::env::var_os("JL_BRIDGE_FIXTURES").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/build"));
    if dir.join("clap/clack-polysynth.clap").exists() {
        Some(dir)
    } else {
        eprintln!("plugin fixtures not built (bash scripts/fixtures.sh): skipped");
        None
    }
}

fn engine_with(plugins: Vec<PluginDescription>) -> Engine {
    let (main, _receiver) = MainHandle::new(Arc::new(|| {}));
    std::mem::forget(_receiver);
    let mut engine = Engine::new(main, AudioRegistry::default());
    engine.set_plugins(plugins);
    engine
}

fn scanned(dir: &PathBuf, format: PluginFormat) -> Vec<PluginDescription> {
    let settings = ScanSettings {
        clap: format == PluginFormat::Clap,
        vst3: format == PluginFormat::Vst3,
        extra_paths: vec![dir.join(format.prefix())],
        builtins: false,
        cache_file: None,
        method: ScanMethod::InProcess,
    };
    scan::scan(&settings, true).into_iter().filter(|plugin| plugin.path.starts_with(dir)).collect()
}

/// Plays `events` through an instance, `blocks` blocks of 256 frames, returns the left channel.
fn play(engine: &Engine, instance: u32, events: &[MidiEvent], input: Option<&[f32]>, blocks: usize) -> Vec<f32> {
    let slot = engine.audio.get(instance).unwrap();
    let mut slot = slot.lock().unwrap();
    let mut left = Vec::new();
    let mut output = vec![0.0f32; 512];
    for block in 0..blocks {
        let block_events: Vec<MidiEvent> = events
            .iter()
            .filter(|event| (block * 256..(block + 1) * 256).contains(&(event.frame as usize)))
            .map(|event| MidiEvent::new(event.frame - (block * 256) as u32, event.bytes))
            .collect();
        let chunk: Vec<f32> = match input {
            Some(input) => input[block * 256..(block + 1) * 256].to_vec(),
            None => Vec::new(),
        };
        slot.process_block(256, if input.is_some() { 1 } else { 0 }, &chunk, &block_events, &mut output).unwrap();
        left.extend_from_slice(&output[..256]);
    }
    left
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0, |peak, sample| peak.max(sample.abs()))
}

#[test]
fn clap_plugins_are_scanned_with_their_kinds() {
    let Some(dir) = fixtures() else { return };
    let plugins = scanned(&dir, PluginFormat::Clap);
    let synth = plugins.iter().find(|plugin| plugin.native_id == "org.rust-audio.clack.polysynth").expect("polysynth listed");
    assert_eq!(synth.kind, PluginKind::Instrument);
    assert_eq!(synth.id, "clap:org.rust-audio.clack.polysynth");
    let gain = plugins.iter().find(|plugin| plugin.native_id == "org.rust-audio.clack.gain").expect("gain listed");
    assert_eq!(gain.kind, PluginKind::Effect);
    // And the crash-proof path gives the same answer.
    let answer: serde_json::Value = serde_json::from_str(&scan::scan_one_answer(PluginFormat::Clap, &synth.path)).unwrap();
    assert_eq!(answer["plugins"][0]["nativeId"], "org.rust-audio.clack.polysynth");
}

#[test]
fn a_clap_synth_plays_notes_and_keeps_its_state() {
    let Some(dir) = fixtures() else { return };
    let plugins = scanned(&dir, PluginFormat::Clap);
    let mut engine = engine_with(plugins);
    let setup = ProcessSetup { sample_rate: 48_000.0, max_block: 128, inputs: 0, outputs: 2, offline: false };
    let created = engine.create(1, "clap:org.rust-audio.clack.polysynth", setup, None, InstanceMode::Live).unwrap();
    let silent = play(&engine, created.instance, &[], None, 8);
    assert_eq!(peak(&silent), 0.0);
    let played = play(&engine, created.instance, &[MidiEvent::new(300, [0x90, 57, 110]), MidiEvent::new(1500, [0x80, 57, 0])], None, 16);
    assert!(peak(&played[..300]) == 0.0, "nothing before the note");
    assert!(peak(&played[300..1500]) > 0.01, "the note sounds (peak {})", peak(&played[300..1500]));

    let params = engine.params(created.instance).unwrap();
    assert!(!params["params"].as_array().unwrap().is_empty(), "the polysynth has a volume parameter");
    let state = engine.get_state(created.instance).unwrap();
    let copy = engine.create(1, "clap:org.rust-audio.clack.polysynth", setup, Some(&base64_decode(&state)), InstanceMode::Offline).unwrap();
    assert_eq!(engine.get_state(copy.instance).unwrap(), state);
    engine.destroy(created.instance, &mut NoWindows).unwrap();
    engine.destroy(copy.instance, &mut NoWindows).unwrap();
}

#[test]
fn a_clap_effect_changes_its_input_by_its_parameter() {
    let Some(dir) = fixtures() else { return };
    let mut engine = engine_with(scanned(&dir, PluginFormat::Clap));
    let setup = ProcessSetup { sample_rate: 44_100.0, max_block: 256, inputs: 2, outputs: 2, offline: false };
    let created = engine.create(1, "clap:org.rust-audio.clack.gain", setup, None, InstanceMode::Live).unwrap();
    let input: Vec<f32> = (0..256 * 4).map(|frame| (frame as f32 * 0.05).sin() * 0.5).collect();
    let before = play(&engine, created.instance, &[], Some(&input), 4);
    assert!(peak(&before) > 0.1, "passes audio (peak {})", peak(&before));
    let params = engine.params(created.instance).unwrap();
    let param = &params["params"][0];
    let id = param["id"].as_u64().unwrap() as u32;
    engine.set_param(created.instance, id, param["min"].as_f64().unwrap()).unwrap();
    let after = play(&engine, created.instance, &[], Some(&input), 4);
    assert!(peak(&after[256..]) < peak(&before) * 0.5, "the parameter took effect: {} vs {}", peak(&after), peak(&before));
}

fn base64_decode(text: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(text).unwrap()
}

fn vst3_fixtures() -> Option<PathBuf> {
    fixtures().filter(|dir| dir.join("vst3/TestSynth.vst3").exists())
}

#[test]
fn vst3_plugins_are_scanned_with_their_kinds() {
    let Some(dir) = vst3_fixtures() else { return };
    let plugins = scanned(&dir, PluginFormat::Vst3);
    for plugin in &plugins {
        println!("{} {} {:?} {} {:?}", plugin.id, plugin.name, plugin.kind, plugin.vendor, plugin.categories);
    }
    assert!(plugins.iter().any(|plugin| plugin.kind == PluginKind::Instrument && plugin.path.ends_with("TestSynth.vst3")));
    assert!(plugins.iter().any(|plugin| plugin.kind == PluginKind::Effect && plugin.path.ends_with("RsGain.vst3")));
    assert!(plugins.iter().all(|plugin| plugin.id.len() == "vst3:".len() + 32));
}

#[test]
fn a_vst3_synth_plays_notes_and_keeps_its_state() {
    let Some(dir) = vst3_fixtures() else { return };
    let plugins = scanned(&dir, PluginFormat::Vst3);
    let synth = plugins.iter().find(|plugin| plugin.kind == PluginKind::Instrument && plugin.path.ends_with("TestSynth.vst3")).unwrap().id.clone();
    let mut engine = engine_with(plugins);
    let setup = ProcessSetup { sample_rate: 48_000.0, max_block: 256, inputs: 0, outputs: 2, offline: false };
    let created = engine.create(1, &synth, setup, None, InstanceMode::Live).unwrap();
    let played = play(&engine, created.instance, &[MidiEvent::new(300, [0x90, 69, 110]), MidiEvent::new(3000, [0x80, 69, 0])], None, 16);
    assert_eq!(peak(&played[..300]), 0.0, "nothing before the note");
    assert!(peak(&played[300..3000]) > 0.01, "the note sounds (peak {})", peak(&played[300..3000]));

    let params = engine.params(created.instance).unwrap();
    let list = params["params"].as_array().unwrap();
    assert!(list.len() > 3, "TestSynth has parameters");
    // Change one through the controller (as a GUI edit would) and see it in the state.
    let before = engine.get_state(created.instance).unwrap();
    let cutoff = list.iter().find(|param| param["name"].as_str().unwrap_or("").contains("Cutoff")).unwrap_or(&list[0]);
    engine.set_param(created.instance, cutoff["id"].as_u64().unwrap() as u32, 0.123).unwrap();
    play(&engine, created.instance, &[], None, 1);
    let after = engine.get_state(created.instance).unwrap();
    assert_ne!(before, after, "the processor took the change and saved it");
    let copy = engine.create(1, &synth, setup, Some(&base64_decode(&after)), InstanceMode::Offline).unwrap();
    assert_eq!(engine.get_state(copy.instance).unwrap(), after, "state restores");
    let copied = engine.params(copy.instance).unwrap();
    let copied_cutoff = copied["params"].as_array().unwrap().iter().find(|param| param["id"] == cutoff["id"]).unwrap();
    assert!((copied_cutoff["value"].as_f64().unwrap() - 0.123).abs() < 1e-6, "the controller learnt it too: {copied_cutoff}");
    engine.destroy(created.instance, &mut NoWindows).unwrap();
    engine.destroy(copy.instance, &mut NoWindows).unwrap();
}

#[test]
fn a_vst3_effect_processes_its_input() {
    let Some(dir) = vst3_fixtures() else { return };
    let plugins = scanned(&dir, PluginFormat::Vst3);
    let gain = plugins.iter().find(|plugin| plugin.path.ends_with("RsGain.vst3")).unwrap().id.clone();
    let mut engine = engine_with(plugins);
    let setup = ProcessSetup { sample_rate: 44_100.0, max_block: 512, inputs: 2, outputs: 2, offline: false };
    let created = engine.create(1, &gain, setup, None, InstanceMode::Live).unwrap();
    let input: Vec<f32> = (0..256 * 4).map(|frame| (frame as f32 * 0.05).sin() * 0.5).collect();
    let out = play(&engine, created.instance, &[], Some(&input), 4);
    assert!((peak(&out) - peak(&input)).abs() < 0.01, "unity gain passes the input ({} vs {})", peak(&out), peak(&input));
    let params = engine.params(created.instance).unwrap();
    let id = params["params"][0]["id"].as_u64().unwrap() as u32;
    engine.set_param(created.instance, id, 0.25).unwrap();
    let quieter = play(&engine, created.instance, &[], Some(&input), 4);
    assert!(peak(&quieter[256..]) < peak(&out) * 0.5, "the gain parameter reached the processor: {} vs {}", peak(&quieter), peak(&out));
}
