//! The instrument engine behind the analog, wavetable and FM synth models: `MAX_VOICES` voices of one generator
//! each (see `voice.rs`), sharing a patch, stereo out.
//!
//! Timing works like `Synth`: every note, release and parameter change is an event stamped with an absolute frame,
//! applied on exactly that frame; events whose frame has passed apply at the start of the next block. Poly mode
//! gives every note a voice (stealing the oldest releasing voice, else the oldest); mono mode plays one voice,
//! legato, and a new note glides from the last one when glide is on (poly glides from the last note played too).

pub mod analog;
pub mod fm;
pub mod params;
pub mod voice;
pub mod wavetable;

use crate::lfo::{lfo_rate, Lfo, LfoShape};
use crate::math::hz_to_note;
use crate::synth::{MAX_BLOCK, MAX_EVENTS, MAX_VOICES};
use alloc::boxed::Box;
use params::*;
pub use params::{Model, Patch, PARAM_COUNT};
use voice::{amp_params, filter_env_params, BlockContext, Shared, Voice, CONTROL_BLOCK};
use wavetable::WavetableBank;

const NEVER: i64 = i64::MAX;
/// Time constant of the pitch bend glide, in seconds.
const BEND_GLIDE_S: f32 = 0.004;
const MAX_BEND: f32 = 48.0;

#[derive(Clone, Copy, Debug)]
enum Event {
    NoteOn { id: u32, note: f32, velocity: f32, release_at: i64 },
    NoteOff { id: u32 },
    Param { id: u32, value: f32 },
}

#[derive(Clone, Copy, Debug)]
struct Queued {
    frame: i64,
    seq: u64,
    event: Event,
}

impl Queued {
    const EMPTY: Queued = Queued { frame: 0, seq: 0, event: Event::NoteOff { id: 0 } };
}

pub struct Instrument {
    model: Model,
    sample_rate: f32,
    patch: Patch,
    tables: WavetableBank,
    voices: Box<[Voice; MAX_VOICES]>,
    mono: bool,
    /// Bend in semitones: where it is and where it is going.
    bend: f32,
    bend_target: f32,
    free_lfos: [Lfo; 2],
    /// The last note started, where a glide starts from.
    last_note: Option<f32>,
    scratch: [[f32; CONTROL_BLOCK]; 2],
    queue: [Queued; MAX_EVENTS],
    queued: usize,
    seq: u64,
    order: u64,
}

impl Instrument {
    pub fn new(sample_rate: f32, model: Model) -> Self {
        let patch = Patch::new(model);
        let mut tables = WavetableBank::new(model == Model::Wavetable);
        for slot in 0..2 {
            tables.select(slot, patch.osc(slot, WT_TABLE) as u32);
        }
        let voices = Box::new(core::array::from_fn(|i| Voice::new(model, sample_rate, &patch, 0x1000 + i as u32 * 7919)));
        Self {
            model,
            sample_rate,
            patch,
            tables,
            voices,
            mono: false,
            bend: 0.0,
            bend_target: 0.0,
            free_lfos: [Lfo::new(3), Lfo::new(5)],
            last_note: None,
            scratch: [[0.0; CONTROL_BLOCK]; 2],
            queue: [Queued::EMPTY; MAX_EVENTS],
            queued: 0,
            seq: 0,
            order: 0,
        }
    }

    pub fn model(&self) -> Model {
        self.model
    }

    pub fn patch(&self) -> &Patch {
        &self.patch
    }

    /// Queues a note at `frame`, released `duration_frames` later, or held until `note_off(id)` when negative.
    pub fn note_on(&mut self, frame: i64, id: u32, hz: f32, velocity: f32, duration_frames: i64) -> bool {
        if !(hz.is_finite() && hz > 0.0 && velocity.is_finite()) {
            return false;
        }
        let release_at = if duration_frames < 0 { NEVER } else { frame.saturating_add(duration_frames) };
        self.push(frame, Event::NoteOn { id, note: hz_to_note(hz), velocity: velocity.clamp(0.0, 1.0), release_at })
    }

    pub fn note_off(&mut self, frame: i64, id: u32) -> bool {
        id != 0 && self.push(frame, Event::NoteOff { id })
    }

    pub fn set_param(&mut self, frame: i64, id: u32, value: f32) -> bool {
        (id as usize) < PARAM_COUNT && value.is_finite() && self.push(frame, Event::Param { id, value })
    }

    pub fn set_mono(&mut self, mono: bool) {
        self.mono = mono;
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|voice| !voice.is_idle()).count()
    }

    /// Renders `left.len()` (== `right.len()`) frames from absolute frame `start`. Returns sounding voices plus
    /// queued events: 0 means silence until the next event.
    pub fn render(&mut self, start: i64, left: &mut [f32], right: &mut [f32]) -> u32 {
        left.fill(0.0);
        right.fill(0.0);
        let mut block_start = start;
        for (l, r) in left.chunks_mut(MAX_BLOCK).zip(right.chunks_mut(MAX_BLOCK)) {
            self.render_block(block_start, l, r);
            block_start += l.len() as i64;
        }
        (self.active_voices() + self.queued) as u32
    }

    fn render_block(&mut self, start: i64, left: &mut [f32], right: &mut [f32]) {
        let len = left.len() as i64;
        let mut pos = 0;
        while pos < len {
            let now = start + pos;
            while let Some(queued) = self.take_due(now) {
                self.apply(queued, now);
            }
            let end = self.next_frame().map_or(len, |frame| (frame - start).clamp(pos + 1, len));
            let mut at = pos;
            while at < end {
                let stop = (at + CONTROL_BLOCK as i64).min(end);
                self.render_control(start + at, &mut left[at as usize..stop as usize], &mut right[at as usize..stop as usize]);
                at = stop;
            }
            pos = end;
        }
    }

    /// One control block: global modulation, then every voice.
    fn render_control(&mut self, start: i64, left: &mut [f32], right: &mut [f32]) {
        let n = left.len();
        let seconds = n as f32 / self.sample_rate;
        let bend_step = 1.0 - libm::expf(-seconds / BEND_GLIDE_S);
        self.bend += (self.bend_target - self.bend) * bend_step;
        if (self.bend_target - self.bend).abs() < 1e-4 {
            self.bend = self.bend_target;
        }
        let glide_s = self.patch.get(GLIDE);
        let glide = if glide_s > 0.0 { 1.0 - libm::expf(-seconds / (glide_s * 0.25)) } else { 1.0 };
        let mut free_lfo = [0.0; 2];
        for (i, lfo) in self.free_lfos.iter_mut().enumerate() {
            let n_lfo = i as u32;
            free_lfo[i] = lfo.value(LfoShape::from_u32(self.patch.lfo(n_lfo, LFO_SHAPE) as u32));
            let rate = lfo_rate(self.patch.lfo(n_lfo, LFO_RATE), self.patch.lfo(n_lfo, LFO_SYNC) as u32, self.patch.get(TEMPO));
            lfo.advance(rate * seconds);
        }
        let cx = BlockContext {
            shared: Shared { sample_rate: self.sample_rate, patch: &self.patch, tables: &self.tables },
            bend: self.bend,
            glide,
            free_lfo,
        };
        for voice in self.voices.iter_mut() {
            if voice.is_idle() {
                continue;
            }
            if voice.release_at < start + n as i64 {
                // Scheduled releases land on a control block edge at most `CONTROL_BLOCK` frames early or late;
                // split the block so they land on their frame.
                let at = (voice.release_at - start).max(0) as usize;
                if at > 0 {
                    voice.render_add(&cx, &mut self.scratch, &mut left[..at], &mut right[..at]);
                }
                voice.release();
                voice.render_add(&cx, &mut self.scratch, &mut left[at..], &mut right[at..]);
            } else {
                voice.render_add(&cx, &mut self.scratch, left, right);
            }
        }
    }

    fn push(&mut self, frame: i64, event: Event) -> bool {
        if self.queued == MAX_EVENTS {
            return false;
        }
        self.queue[self.queued] = Queued { frame, seq: self.seq, event };
        self.queued += 1;
        self.seq += 1;
        true
    }

    fn take_due(&mut self, frame: i64) -> Option<Queued> {
        let mut best: Option<usize> = None;
        for (index, queued) in self.queue[..self.queued].iter().enumerate() {
            if queued.frame <= frame && best.is_none_or(|b| (queued.frame, queued.seq) < (self.queue[b].frame, self.queue[b].seq)) {
                best = Some(index);
            }
        }
        let index = best?;
        let queued = self.queue[index];
        self.queued -= 1;
        self.queue[index] = self.queue[self.queued];
        Some(queued)
    }

    fn next_frame(&self) -> Option<i64> {
        self.queue[..self.queued].iter().map(|queued| queued.frame).min()
    }

    fn apply(&mut self, queued: Queued, now: i64) {
        match queued.event {
            Event::NoteOn { id, note, velocity, release_at } => {
                if release_at <= now {
                    return;
                }
                let index = self.voice_for_note();
                self.order += 1;
                let order = self.order;
                if self.mono {
                    for (other, voice) in self.voices.iter_mut().enumerate() {
                        if other != index && !voice.is_idle() {
                            voice.release();
                        }
                    }
                }
                let from = if self.patch.get(GLIDE) > 0.0 { self.last_note } else { None };
                let shared = Shared { sample_rate: self.sample_rate, patch: &self.patch, tables: &self.tables };
                self.voices[index].start(&shared, id, note, velocity, from, release_at, order);
                self.last_note = Some(note);
            }
            Event::NoteOff { id } => {
                for voice in self.voices.iter_mut() {
                    if voice.id == id && voice.gate && !voice.is_idle() {
                        voice.release();
                    }
                }
            }
            Event::Param { id, value } => self.apply_param(id, value),
        }
    }

    fn apply_param(&mut self, id: u32, value: f32) {
        if id == BEND {
            self.bend_target = value.clamp(-MAX_BEND, MAX_BEND);
        }
        self.patch.set(id, value);
        match id {
            AMP_ATTACK..=AMP_RELEASE => {
                let params = amp_params(&self.patch);
                for voice in self.voices.iter_mut() {
                    voice.amp.set_params(params);
                }
            }
            FILTER_ATTACK..=FILTER_RELEASE => {
                let params = filter_env_params(&self.patch);
                for voice in self.voices.iter_mut() {
                    voice.filter_env.set_params(params);
                }
            }
            _ if self.model == Model::Wavetable && (id == OSC + WT_TABLE || id == OSC + OSC_STRIDE + WT_TABLE) => {
                let slot = (id - OSC) / OSC_STRIDE;
                self.tables.select(slot, value.max(0.0) as u32);
            }
            _ if self.model == Model::Fm && id >= OP => {
                let shared = Shared { sample_rate: self.sample_rate, patch: &self.patch, tables: &self.tables };
                for voice in self.voices.iter_mut() {
                    voice.generator.update(&shared);
                }
            }
            _ => {}
        }
    }

    fn voice_for_note(&self) -> usize {
        let latest_sounding = || (0..MAX_VOICES).filter(|&i| !self.voices[i].is_idle()).max_by_key(|&i| self.voices[i].order);
        let free = || (0..MAX_VOICES).find(|&i| self.voices[i].is_idle());
        let oldest = |released_only: bool| (0..MAX_VOICES).filter(|&i| !released_only || !self.voices[i].gate).min_by_key(|&i| self.voices[i].order);
        if self.mono {
            if let Some(index) = latest_sounding() {
                return index;
            }
        }
        free().or_else(|| oldest(true)).or_else(|| oldest(false)).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests;
