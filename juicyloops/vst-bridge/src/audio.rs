//! The audio side of every instance: its processor plus scratch buffers, and the two ways it runs.
//!
//! * `process_block`: one block from the studio (live, or one chunk of an effect in an export). Blocks bigger than
//!   the plugin's maximum are split; events are moved to the sub-block they fall in.
//! * `render`: a whole range as fast as possible (an instrument in an export): all events known up front.
//!
//! Nothing here allocates once an instance runs: the scratch buffers are sized when it is activated.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use crate::error::BridgeError;
use crate::plugin::{MidiEvent, ProcessBuffers, ProcessSetup, Processor, Transport};

/// What the audio thread holds of one instance.
pub struct AudioSlot {
    processor: Option<Box<dyn Processor>>,
    pub setup: ProcessSetup,
    pub transport: Transport,
    /// Scratch: one buffer per plugin input and output channel, `max_block` long.
    inputs: Vec<Vec<f32>>,
    outputs: Vec<Vec<f32>>,
    /// Scratch: the events of one sub-block, rebased to it.
    block_events: Vec<MidiEvent>,
}

impl AudioSlot {
    pub fn new(processor: Box<dyn Processor>, setup: ProcessSetup) -> Self {
        let block = setup.max_block.max(1) as usize;
        Self {
            processor: Some(processor),
            setup,
            transport: Transport::default(),
            inputs: (0..setup.inputs).map(|_| vec![0.0; block]).collect(),
            outputs: (0..setup.outputs).map(|_| vec![0.0; block]).collect(),
            block_events: Vec::with_capacity(512),
        }
    }

    /// Takes the processor out (to deactivate it); later blocks fail with "no instance".
    pub fn take_processor(&mut self) -> Option<Box<dyn Processor>> {
        self.processor.take()
    }

    pub fn put_processor(&mut self, processor: Box<dyn Processor>) {
        self.processor = Some(processor);
    }

    pub fn reset(&mut self) {
        if let Some(processor) = self.processor.as_mut() {
            processor.reset();
        }
    }

    pub fn out_channels(&self) -> u32 {
        self.setup.outputs
    }

    /// Processes `frames` frames. `input` is planar with `in_channels` channels (any count: a mono input feeds
    /// every plugin input, missing ones get silence); `output` receives `setup.outputs` planar channels.
    /// `events` are sorted, at frames `< frames`.
    pub fn process_block(&mut self, frames: usize, in_channels: usize, input: &[f32], events: &[MidiEvent], output: &mut [f32]) -> Result<(), BridgeError> {
        let out_channels = self.setup.outputs as usize;
        debug_assert!(output.len() >= out_channels * frames);
        let block = self.setup.max_block.max(1) as usize;
        let Some(processor) = self.processor.as_mut() else {
            return Err(BridgeError::not_found("The instance is gone."));
        };
        let mut next_event = 0usize;
        let mut position = 0usize;
        while position < frames {
            let length = block.min(frames - position);
            // Input for this sub-block.
            for (channel, buffer) in self.inputs.iter_mut().enumerate() {
                let source = if in_channels == 0 { None } else { Some(channel.min(in_channels - 1)) };
                match source {
                    Some(source) => buffer[..length].copy_from_slice(&input[source * frames + position..source * frames + position + length]),
                    None => buffer[..length].fill(0.0),
                }
            }
            // Its events, rebased.
            self.block_events.clear();
            while next_event < events.len() && (events[next_event].frame as usize) < position + length {
                let event = events[next_event];
                self.block_events.push(MidiEvent::new((event.frame as usize).saturating_sub(position) as u32, event.bytes));
                next_event += 1;
            }
            {
                let inputs: [&[f32]; 2] = match self.inputs.len() {
                    0 => [&[], &[]],
                    1 => [&self.inputs[0][..length], &[]],
                    _ => [&self.inputs[0][..length], &self.inputs[1][..length]],
                };
                let (first, rest) = self.outputs.split_at_mut(out_channels.min(1));
                let mut outputs: [&mut [f32]; 2] = match (first.first_mut(), rest.first_mut()) {
                    (Some(left), Some(right)) => [&mut left[..length], &mut right[..length]],
                    (Some(left), None) => [&mut left[..length], &mut []],
                    _ => [&mut [], &mut []],
                };
                let input_count = self.inputs.len().min(2);
                let output_count = out_channels.min(2);
                processor.process(
                    ProcessBuffers { inputs: &inputs[..input_count], outputs: &mut outputs[..output_count], frames: length as u32 },
                    &self.block_events,
                    &self.transport,
                )?;
            }
            for (channel, buffer) in self.outputs.iter().enumerate() {
                output[channel * frames + position..channel * frames + position + length].copy_from_slice(&buffer[..length]);
            }
            position += length;
        }
        Ok(())
    }

    /// Renders `frames` frames from a clean start: `events` at absolute frames (sorted), `input` planar
    /// (`in_channels × frames`, empty for an instrument). Hands each chunk of `chunk` frames to `emit` (planar,
    /// `setup.outputs` channels) as soon as it is done.
    pub fn render(
        &mut self,
        frames: u64,
        in_channels: usize,
        input: &[f32],
        events: &[MidiEvent],
        chunk: u32,
        mut emit: impl FnMut(u64, u32, &[f32], bool) -> Result<(), BridgeError>,
    ) -> Result<(), BridgeError> {
        self.reset();
        let out_channels = self.setup.outputs as usize;
        let chunk = chunk.max(1) as u64;
        let mut chunk_input = vec![0.0f32; in_channels * chunk as usize];
        let mut chunk_output = vec![0.0f32; out_channels * chunk as usize];
        let mut chunk_events: Vec<MidiEvent> = Vec::new();
        let mut next_event = 0usize;
        let mut start = 0u64;
        while start < frames {
            let length = chunk.min(frames - start) as usize;
            for channel in 0..in_channels {
                let from = channel * frames as usize + start as usize;
                chunk_input[channel * length..(channel + 1) * length].copy_from_slice(&input[from..from + length]);
            }
            chunk_events.clear();
            while next_event < events.len() && (events[next_event].frame as u64) < start + length as u64 {
                let event = events[next_event];
                chunk_events.push(MidiEvent::new((event.frame as u64).saturating_sub(start) as u32, event.bytes));
                next_event += 1;
            }
            let output = &mut chunk_output[..out_channels * length];
            self.process_block(length, in_channels, &chunk_input[..in_channels * length], &chunk_events, output)?;
            let last = start + length as u64 >= frames;
            emit(start, length as u32, output, last)?;
            start += length as u64;
        }
        Ok(())
    }
}

/// The instances the audio side can reach, by id. The main thread adds and removes; audio threads look up.
#[derive(Clone, Default)]
pub struct AudioRegistry {
    slots: Arc<RwLock<HashMap<u32, Arc<Mutex<AudioSlot>>>>>,
}

impl AudioRegistry {
    pub fn insert(&self, instance: u32, slot: AudioSlot) {
        self.slots.write().unwrap_or_else(|poison| poison.into_inner()).insert(instance, Arc::new(Mutex::new(slot)));
    }

    pub fn remove(&self, instance: u32) -> Option<Arc<Mutex<AudioSlot>>> {
        self.slots.write().unwrap_or_else(|poison| poison.into_inner()).remove(&instance)
    }

    pub fn get(&self, instance: u32) -> Option<Arc<Mutex<AudioSlot>>> {
        self.slots.read().unwrap_or_else(|poison| poison.into_inner()).get(&instance).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin;

    fn slot(id: &str, max_block: u32, inputs: u32) -> (Box<dyn crate::plugin::Plugin>, AudioSlot) {
        let mut plugin = builtin::instantiate(id).unwrap();
        let setup = ProcessSetup { sample_rate: 48_000.0, max_block, inputs, outputs: 2, offline: false };
        let processor = plugin.activate(setup).unwrap();
        (plugin, AudioSlot::new(processor, setup))
    }

    #[test]
    fn a_block_bigger_than_the_plugins_maximum_is_split_with_its_events() {
        // The same note, rendered in one 1000-frame block through a plugin that takes 64 at a time, and through
        // one that takes all 1000 at once, must come out identical.
        let events = [MidiEvent::new(130, [0x90, 69, 100]), MidiEvent::new(700, [0x80, 69, 0])];
        let (_small_plugin, mut small) = slot(builtin::SYNTH_ID, 64, 0);
        let (_big_plugin, mut big) = slot(builtin::SYNTH_ID, 1000, 0);
        let mut split = vec![0.0; 2000];
        let mut whole = vec![0.0; 2000];
        small.process_block(1000, 0, &[], &events, &mut split).unwrap();
        big.process_block(1000, 0, &[], &events, &mut whole).unwrap();
        assert_eq!(split, whole);
        assert!(split[..131].iter().all(|sample| *sample == 0.0));
        assert!(split[131..700].iter().any(|sample| sample.abs() > 0.1));
    }

    #[test]
    fn a_mono_input_feeds_both_sides_of_an_effect() {
        let (_plugin, mut gain) = slot(builtin::GAIN_ID, 128, 2);
        let input = [1.0f32, 0.5, -1.0];
        let mut output = [0.0f32; 6];
        gain.process_block(3, 1, &input, &[], &mut output).unwrap();
        assert_eq!(output, [0.5, 0.25, -0.5, 0.5, 0.25, -0.5]);
    }

    #[test]
    fn render_matches_block_by_block_processing_and_starts_clean() {
        let events = [MidiEvent::new(10, [0x90, 60, 127]), MidiEvent::new(5000, [0x80, 60, 0]), MidiEvent::new(9000, [0x90, 72, 64])];
        let (_plugin, mut renderer) = slot(builtin::SYNTH_ID, 256, 0);
        // Leave a voice hanging first: render must start from silence anyway.
        let mut junk = vec![0.0; 512];
        renderer.process_block(256, 0, &[], &[MidiEvent::new(0, [0x90, 40, 127])], &mut junk).unwrap();

        let frames = 12_288u64;
        let mut rendered = vec![0.0f32; 2 * frames as usize];
        let mut chunks = 0;
        let mut saw_last = false;
        renderer
            .render(frames, 0, &[], &events, 4096, |start, length, output, last| {
                for channel in 0..2 {
                    let to = channel * frames as usize + start as usize;
                    rendered[to..to + length as usize].copy_from_slice(&output[channel * length as usize..(channel + 1) * length as usize]);
                }
                chunks += 1;
                saw_last = last;
                Ok(())
            })
            .unwrap();
        assert_eq!(chunks, 3);
        assert!(saw_last);

        let (_plugin, mut live) = slot(builtin::SYNTH_ID, 128, 0);
        let mut expected = vec![0.0f32; 2 * frames as usize];
        let mut block = vec![0.0f32; 256];
        for start in (0..frames as usize).step_by(128) {
            let block_events: Vec<MidiEvent> = events
                .iter()
                .filter(|event| (start..start + 128).contains(&(event.frame as usize)))
                .map(|event| MidiEvent::new(event.frame - start as u32, event.bytes))
                .collect();
            live.process_block(128, 0, &[], &block_events, &mut block).unwrap();
            expected[start..start + 128].copy_from_slice(&block[..128]);
            expected[frames as usize + start..frames as usize + start + 128].copy_from_slice(&block[128..]);
        }
        assert_eq!(rendered, expected);
        assert!(rendered[..11].iter().all(|sample| *sample == 0.0), "the hanging voice was reset");
    }
}
