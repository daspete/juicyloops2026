//! The bridge's own test plugins: a sine synth and a gain effect. They let every part of the pipeline (protocol,
//! block processing, render mode, the studio's client) be tested without a third-party plugin, and give a user a
//! quick "does the bridge work" check. Listed only when the bridge runs with `--builtin-plugins`.

use std::any::Any;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use crate::error::BridgeError;
use crate::plugin::{MidiEvent, ParamInfo, Plugin, PluginDescription, PluginFormat, PluginKind, ProcessBuffers, ProcessSetup, Processor, Transport};

pub const SYNTH_ID: &str = "builtin:sine-synth";
pub const GAIN_ID: &str = "builtin:gain";

pub fn descriptions() -> Vec<PluginDescription> {
    vec![
        PluginDescription {
            id: SYNTH_ID.into(),
            format: PluginFormat::Builtin,
            native_id: "sine-synth".into(),
            name: "Bridge Test Synth".into(),
            vendor: "Juicy Loops".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            kind: PluginKind::Instrument,
            categories: vec!["Synth".into()],
            path: PathBuf::new(),
        },
        PluginDescription {
            id: GAIN_ID.into(),
            format: PluginFormat::Builtin,
            native_id: "gain".into(),
            name: "Bridge Test Gain".into(),
            vendor: "Juicy Loops".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            kind: PluginKind::Effect,
            categories: vec!["Utility".into()],
            path: PathBuf::new(),
        },
    ]
}

pub fn instantiate(id: &str) -> Result<Box<dyn Plugin>, BridgeError> {
    let description =
        descriptions().into_iter().find(|description| description.id == id).ok_or_else(|| BridgeError::not_found(format!("No built-in plugin {id}.")))?;
    Ok(Box::new(Builtin { description, gain: Arc::new(AtomicU32::new(0.5f32.to_bits())), active: false }))
}

/// The one parameter both built-ins have: output gain, 0..1 (the synth's default 0.5, the effect's 0.5 too).
const GAIN_PARAM: u32 = 0;

struct Builtin {
    description: PluginDescription,
    /// Shared with the processor: set from the main thread, read per block.
    gain: Arc<AtomicU32>,
    active: bool,
}

impl Builtin {
    fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Relaxed))
    }
}

impl Plugin for Builtin {
    fn description(&self) -> &PluginDescription {
        &self.description
    }

    fn activate(&mut self, setup: ProcessSetup) -> Result<Box<dyn Processor>, BridgeError> {
        if self.active {
            return Err(BridgeError::internal("The plugin is active already."));
        }
        self.active = true;
        Ok(match self.description.kind {
            PluginKind::Instrument => Box::new(SineSynth::new(setup.sample_rate, self.gain.clone())),
            PluginKind::Effect => Box::new(Gain { gain: self.gain.clone() }),
        })
    }

    fn deactivate(&mut self, _processor: Box<dyn Processor>) {
        self.active = false;
    }

    /// State format: the gain as 4 little-endian bytes of an f32, after a 4-byte tag.
    fn save_state(&mut self) -> Result<Vec<u8>, BridgeError> {
        let mut chunk = b"JLB1".to_vec();
        chunk.extend_from_slice(&self.gain().to_le_bytes());
        Ok(chunk)
    }

    fn load_state(&mut self, chunk: &[u8]) -> Result<(), BridgeError> {
        if chunk.len() != 8 || &chunk[..4] != b"JLB1" {
            return Err(BridgeError::plugin("That is not a state of this plugin."));
        }
        let gain = f32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
        self.gain.store(gain.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        Ok(())
    }

    fn params(&mut self) -> Vec<ParamInfo> {
        vec![ParamInfo {
            id: GAIN_PARAM,
            name: "Gain".into(),
            module: String::new(),
            min: 0.0,
            max: 1.0,
            default: 0.5,
            value: self.gain() as f64,
            automatable: true,
        }]
    }

    fn set_param(&mut self, id: u32, value: f64) -> Result<(), BridgeError> {
        if id != GAIN_PARAM {
            return Err(BridgeError::not_found(format!("No parameter {id}.")));
        }
        self.gain.store((value.clamp(0.0, 1.0) as f32).to_bits(), Ordering::Relaxed);
        Ok(())
    }
}

struct Gain {
    gain: Arc<AtomicU32>,
}

impl Processor for Gain {
    fn process(&mut self, buffers: ProcessBuffers<'_, '_>, _events: &[MidiEvent], _transport: &Transport) -> Result<(), BridgeError> {
        let gain = f32::from_bits(self.gain.load(Ordering::Relaxed));
        let frames = buffers.frames as usize;
        for (index, output) in buffers.outputs.iter_mut().enumerate() {
            match buffers.inputs.get(index).or(buffers.inputs.first()) {
                Some(input) => {
                    for (out, sample) in output[..frames].iter_mut().zip(&input[..frames]) {
                        *out = sample * gain;
                    }
                }
                None => output[..frames].fill(0.0),
            }
        }
        Ok(())
    }

    fn reset(&mut self) {}

    fn into_any(self: Box<Self>) -> Box<dyn Any + Send> {
        self
    }
}

const VOICES: usize = 16;

#[derive(Clone, Copy)]
struct Voice {
    key: u8,
    phase: f64,
    step: f64,
    level: f32,
    /// Target of the envelope: the velocity while held, 0 once released.
    target: f32,
    active: bool,
}

const SILENT: Voice = Voice { key: 0, phase: 0.0, step: 0.0, level: 0.0, target: 0.0, active: false };

/// A polyphonic sine with a short linear attack and release, pitch bend of ±2 semitones. Deterministic, so tests
/// can predict its output exactly.
struct SineSynth {
    sample_rate: f64,
    gain: Arc<AtomicU32>,
    voices: [Voice; VOICES],
    bend: f64,
    /// Envelope change per frame.
    attack: f32,
    release: f32,
}

impl SineSynth {
    fn new(sample_rate: f64, gain: Arc<AtomicU32>) -> Self {
        Self {
            sample_rate,
            gain,
            voices: [SILENT; VOICES],
            bend: 0.0,
            attack: (1.0 / (0.005 * sample_rate)) as f32,
            release: (1.0 / (0.05 * sample_rate)) as f32,
        }
    }

    fn step_for(&self, key: u8) -> f64 {
        let frequency = 440.0 * 2f64.powf((key as f64 - 69.0 + self.bend) / 12.0);
        frequency / self.sample_rate
    }

    fn apply(&mut self, event: &MidiEvent) {
        if event.is_note_on() {
            let key = event.bytes[1];
            let step = self.step_for(key);
            let velocity = event.bytes[2] as f32 / 127.0;
            // A free voice, else the quietest.
            let slot = self.voices.iter().position(|voice| !voice.active).unwrap_or_else(|| {
                let mut quietest = 0;
                for (index, voice) in self.voices.iter().enumerate() {
                    if voice.level < self.voices[quietest].level {
                        quietest = index;
                    }
                }
                quietest
            });
            self.voices[slot] = Voice { key, phase: 0.0, step, level: 0.0, target: velocity, active: true };
        } else if event.is_note_off() {
            for voice in self.voices.iter_mut().filter(|voice| voice.active && voice.key == event.bytes[1]) {
                voice.target = 0.0;
            }
        } else if event.status() == 0xe0 {
            let value = (event.bytes[1] as i32) | ((event.bytes[2] as i32) << 7);
            self.bend = (value - 8192) as f64 / 8192.0 * 2.0;
            for index in 0..VOICES {
                let key = self.voices[index].key;
                self.voices[index].step = self.step_for(key);
            }
        } else if event.status() == 0xb0 && (event.bytes[1] == 120 || event.bytes[1] == 123) {
            self.voices = [SILENT; VOICES];
        }
    }

    fn render(&mut self, left: &mut [f32], right: Option<&mut [f32]>) {
        let gain = f32::from_bits(self.gain.load(Ordering::Relaxed));
        for sample in left.iter_mut() {
            let mut sum = 0.0f32;
            for voice in self.voices.iter_mut().filter(|voice| voice.active) {
                if voice.level < voice.target {
                    voice.level = (voice.level + self.attack).min(voice.target);
                } else if voice.level > voice.target {
                    voice.level = (voice.level - self.release).max(voice.target);
                    if voice.level <= 0.0 && voice.target <= 0.0 {
                        voice.active = false;
                        continue;
                    }
                }
                sum += (voice.phase * std::f64::consts::TAU).sin() as f32 * voice.level;
                voice.phase = (voice.phase + voice.step).fract();
            }
            *sample = sum * gain;
        }
        if let Some(right) = right {
            right.copy_from_slice(left);
        }
    }
}

impl Processor for SineSynth {
    fn process(&mut self, buffers: ProcessBuffers<'_, '_>, events: &[MidiEvent], _transport: &Transport) -> Result<(), BridgeError> {
        let frames = buffers.frames as usize;
        let mut position = 0usize;
        let mut next = 0usize;
        let (first, rest) = match buffers.outputs.split_first_mut() {
            Some(split) => split,
            None => return Ok(()),
        };
        let mut right = rest.first_mut();
        // Sample accurate: render up to each event, apply it, go on.
        while position < frames {
            while next < events.len() && events[next].frame as usize <= position {
                self.apply(&events[next]);
                next += 1;
            }
            let end = events.get(next).map_or(frames, |event| (event.frame as usize).clamp(position + 1, frames));
            let right_slice = right.as_mut().map(|right| &mut right[position..end]);
            self.render(&mut first[position..end], right_slice);
            position = end;
        }
        for event in &events[next..] {
            self.apply(event);
        }
        Ok(())
    }

    fn reset(&mut self) {
        self.voices = [SILENT; VOICES];
        self.bend = 0.0;
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any + Send> {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(processor: &mut dyn Processor, events: &[MidiEvent], frames: usize) -> Vec<f32> {
        let mut left = vec![0.0; frames];
        let mut right = vec![0.0; frames];
        {
            let mut outputs: [&mut [f32]; 2] = [&mut left, &mut right];
            processor.process(ProcessBuffers { inputs: &[], outputs: &mut outputs, frames: frames as u32 }, events, &Transport::default()).unwrap();
        }
        assert_eq!(left, right);
        left
    }

    #[test]
    fn synth_is_silent_until_its_note_and_plays_it_sample_accurately() {
        let mut plugin = instantiate(SYNTH_ID).unwrap();
        let mut processor = plugin.activate(ProcessSetup { sample_rate: 48_000.0, max_block: 512, inputs: 0, outputs: 2, offline: false }).unwrap();
        let out = run(processor.as_mut(), &[MidiEvent::new(100, [0x90, 69, 127])], 512);
        assert!(out[..101].iter().all(|sample| *sample == 0.0), "silent before the note");
        assert!(out[101..].iter().any(|sample| sample.abs() > 0.01), "sounds after it");
        plugin.deactivate(processor);
    }

    #[test]
    fn gain_scales_and_state_round_trips() {
        let mut plugin = instantiate(GAIN_ID).unwrap();
        plugin.set_param(GAIN_PARAM, 0.25).unwrap();
        let state = plugin.save_state().unwrap();
        let mut other = instantiate(GAIN_ID).unwrap();
        other.load_state(&state).unwrap();
        assert_eq!(other.params()[0].value, 0.25);
        let mut processor = other.activate(ProcessSetup { sample_rate: 48_000.0, max_block: 4, inputs: 2, outputs: 2, offline: false }).unwrap();
        let input = [1.0f32, -1.0, 0.5, 0.0];
        let mut left = [0.0f32; 4];
        let mut right = [0.0f32; 4];
        {
            let inputs: [&[f32]; 2] = [&input, &input];
            let mut outputs: [&mut [f32]; 2] = [&mut left, &mut right];
            processor.process(ProcessBuffers { inputs: &inputs, outputs: &mut outputs, frames: 4 }, &[], &Transport::default()).unwrap();
        }
        assert_eq!(left, [0.25, -0.25, 0.125, 0.0]);
        assert!(other.load_state(b"nope").is_err());
    }
}
