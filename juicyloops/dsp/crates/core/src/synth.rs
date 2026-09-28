//! Polyphonic synth voice engine: a pool of band-limited oscillator + ADSR voices, summed to one mono signal.
//!
//! Everything the host asks for is an event stamped with an absolute frame (the audio context's frame counter),
//! queued, and applied at exactly that frame while rendering, so timing is sample-accurate inside a block. Events
//! whose frame has already passed apply at the start of the next block.
//!
//! - **Poly mode** (notes overlap): every note gets a voice of its own. When all `MAX_VOICES` are busy, the oldest
//!   releasing voice is taken, else the oldest one.
//! - **Mono mode** (notes cut): one voice. A new note takes over the voice that sounds (legato: the envelope attacks
//!   from where it is and the pitch changes with a continuous phase, so neither clicks), and owns its release time.
//!
//! A taken-over voice glides to the new velocity, and the sustain level glides when it changes, so neither zips.
//! Attack, decay and release times apply to sounding voices at once; a new time only changes the rate.

use crate::{Adsr, AdsrParams, OnePole, PolyBlepOsc, Waveform};

/// Voices per engine.
pub const MAX_VOICES: usize = 16;
/// Events that can wait in the queue at once. The host schedules about 0.2 s ahead, which is far less.
pub const MAX_EVENTS: usize = 256;
/// Longest stretch rendered in one go (one Web Audio render quantum). `render` splits longer buffers.
pub const MAX_BLOCK: usize = 128;

/// Time constant of the velocity glide when a sounding voice is taken over, in seconds.
const VELOCITY_GLIDE_S: f32 = 0.003;
/// Time constant of the sustain level glide, in seconds.
const SUSTAIN_GLIDE_S: f32 = 0.005;

const NEVER: i64 = i64::MAX;

/// Output level per waveform, matched to the Tone.js synth this engine replaces (so mixes keep their balance): Web
/// Audio normalizes its band-limited square and sawtooth to a peak of 1, Gibbs overshoot included, which puts them
/// about 1.4 dB below a full-scale naive wave. Sine and triangle have no overshoot.
fn waveform_level(waveform: Waveform) -> f32 {
    match waveform {
        Waveform::Square | Waveform::Sawtooth => 0.85,
        Waveform::Sine | Waveform::Triangle => 1.0,
    }
}

/// What `set_param` can change. The numbers are part of the C ABI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Param {
    /// `Waveform` as a number (0 sine, 1 square, 2 triangle, 3 sawtooth).
    Waveform = 0,
    /// Seconds.
    Attack = 1,
    /// Seconds.
    Decay = 2,
    /// Level, 0..=1.
    Sustain = 3,
    /// Seconds.
    Release = 4,
}

impl Param {
    pub fn from_u32(id: u32) -> Option<Self> {
        Some(match id {
            0 => Param::Waveform,
            1 => Param::Attack,
            2 => Param::Decay,
            3 => Param::Sustain,
            4 => Param::Release,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug)]
enum Event {
    NoteOn { hz: f32, velocity: f32, release_at: i64 },
    Param { param: Param, value: f32 },
}

#[derive(Clone, Copy, Debug)]
struct Queued {
    frame: i64,
    /// Arrival order, so events for the same frame apply in the order they were sent.
    seq: u64,
    event: Event,
}

impl Queued {
    const EMPTY: Queued = Queued { frame: 0, seq: 0, event: Event::Param { param: Param::Waveform, value: 0.0 } };
}

#[derive(Clone, Debug)]
struct Voice {
    osc: PolyBlepOsc,
    env: Adsr,
    velocity: OnePole,
    /// When the voice was (re)started, for oldest-first stealing and for finding the mono voice.
    order: u64,
    /// Absolute frame the gate closes at, `NEVER` once it has.
    release_at: i64,
}

impl Voice {
    fn new(sample_rate: f32, params: AdsrParams) -> Self {
        Self {
            osc: PolyBlepOsc::new(sample_rate, Waveform::Sine),
            env: Adsr::new(sample_rate, params),
            velocity: OnePole::new(sample_rate, VELOCITY_GLIDE_S, 0.0),
            order: 0,
            release_at: NEVER,
        }
    }

    fn is_idle(&self) -> bool {
        self.env.is_idle()
    }

    fn start(&mut self, hz: f32, velocity: f32, release_at: i64, order: u64) {
        if self.is_idle() {
            // A fresh voice starts at phase 0 and level 0, so its first samples ramp up from silence.
            self.osc.reset(0.0);
            self.velocity.jump(velocity);
        } else {
            self.velocity.set_target(velocity);
        }
        self.osc.set_frequency(hz);
        self.env.gate_on();
        self.release_at = release_at;
        self.order = order;
    }

    fn release(&mut self) {
        self.env.gate_off();
        self.release_at = NEVER;
    }

    /// Adds the voice to `out`, which starts at absolute frame `start`. `sustain` holds per-sample sustain levels
    /// while the level glides.
    fn render_add(&mut self, out: &mut [f32], start: i64, sustain: Option<&[f32]>) {
        if self.is_idle() {
            return;
        }
        let end = start + out.len() as i64;
        let mut from = 0;
        if self.release_at < end {
            let at = (self.release_at - start).max(0) as usize;
            self.run(&mut out[..at], sustain.map(|levels| &levels[..at]));
            self.release();
            from = at;
        }
        self.run(&mut out[from..], sustain.map(|levels| &levels[from..]));
    }

    #[inline]
    fn run(&mut self, out: &mut [f32], sustain: Option<&[f32]>) {
        match sustain {
            Some(levels) => {
                for (sample, &level) in out.iter_mut().zip(levels) {
                    self.env.set_sustain(level);
                    *sample += self.osc.next_sample() * self.env.next_sample() * self.velocity.next_sample();
                }
            }
            None => {
                for sample in out.iter_mut() {
                    if self.env.is_idle() {
                        break;
                    }
                    *sample += self.osc.next_sample() * self.env.next_sample() * self.velocity.next_sample();
                }
            }
        }
    }
}

pub struct Synth {
    voices: [Voice; MAX_VOICES],
    mono: bool,
    /// `waveform_level` of the current waveform.
    level: f32,
    /// Envelope times as set; `sustain` here is the target, the gliding level is `sustain`.
    params: AdsrParams,
    sustain: OnePole,
    sustain_levels: [f32; MAX_BLOCK],
    queue: [Queued; MAX_EVENTS],
    queued: usize,
    seq: u64,
    order: u64,
}

impl Synth {
    pub fn new(sample_rate: f32) -> Self {
        let params = AdsrParams::default();
        Self {
            voices: core::array::from_fn(|_| Voice::new(sample_rate, params)),
            mono: false,
            level: 1.0,
            params,
            sustain: OnePole::new(sample_rate, SUSTAIN_GLIDE_S, params.sustain),
            sustain_levels: [0.0; MAX_BLOCK],
            queue: [Queued::EMPTY; MAX_EVENTS],
            queued: 0,
            seq: 0,
            order: 0,
        }
    }

    /// Queues a note at `frame` that is released `duration_frames` later. False when it is invalid or the queue is full.
    pub fn note_on(&mut self, frame: i64, hz: f32, velocity: f32, duration_frames: i64) -> bool {
        if !(hz.is_finite() && hz > 0.0 && velocity.is_finite()) {
            return false;
        }
        let release_at = frame.saturating_add(duration_frames.max(0));
        self.push(frame, Event::NoteOn { hz, velocity: velocity.clamp(0.0, 1.0), release_at })
    }

    /// Queues a parameter change at `frame`. False for an unknown id, a non-finite value or a full queue.
    pub fn set_param(&mut self, frame: i64, id: u32, value: f32) -> bool {
        match Param::from_u32(id) {
            Some(param) if value.is_finite() => self.push(frame, Event::Param { param, value }),
            _ => false,
        }
    }

    /// Mono (notes cut) or poly (notes overlap). Takes effect with the next note; sounding voices ring out.
    pub fn set_mono(&mut self, mono: bool) {
        self.mono = mono;
    }

    pub fn is_mono(&self) -> bool {
        self.mono
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|voice| !voice.is_idle()).count()
    }

    pub fn queued_events(&self) -> usize {
        self.queued
    }

    /// Renders `out` (mono), whose first sample is absolute frame `start`, and returns how much is still going on:
    /// sounding voices plus queued events. Zero means the engine is silent until the next event arrives.
    pub fn render(&mut self, start: i64, out: &mut [f32]) -> u32 {
        out.fill(0.0);
        let mut block_start = start;
        for block in out.chunks_mut(MAX_BLOCK) {
            self.render_block(block_start, block);
            block_start += block.len() as i64;
        }
        (self.active_voices() + self.queued) as u32
    }

    fn render_block(&mut self, start: i64, out: &mut [f32]) {
        let len = out.len() as i64;
        let mut pos = 0;
        while pos < len {
            let now = start + pos;
            while let Some(queued) = self.take_due(now) {
                self.apply(queued, now);
            }
            let end = self.next_frame().map_or(len, |frame| (frame - start).clamp(pos + 1, len));
            self.render_segment(now, &mut out[pos as usize..end as usize]);
            pos = end;
        }
    }

    fn render_segment(&mut self, start: i64, out: &mut [f32]) {
        let gliding = !self.sustain.is_settled();
        if gliding {
            for level in &mut self.sustain_levels[..out.len()] {
                *level = self.sustain.next_sample();
            }
        }
        let levels = if gliding { Some(&self.sustain_levels[..out.len()]) } else { None };
        for voice in &mut self.voices {
            voice.render_add(out, start, levels);
        }
        if self.level != 1.0 {
            for sample in out.iter_mut() {
                *sample *= self.level;
            }
        }
        if gliding && self.sustain.is_settled() {
            let level = self.sustain.value();
            for voice in &mut self.voices {
                voice.env.set_sustain(level);
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

    /// Removes and returns the earliest event due at or before `frame`.
    fn take_due(&mut self, frame: i64) -> Option<Queued> {
        let mut best: Option<usize> = None;
        for (index, queued) in self.queue[..self.queued].iter().enumerate() {
            if queued.frame <= frame
                && best.is_none_or(|b| (queued.frame, queued.seq) < (self.queue[b].frame, self.queue[b].seq))
            {
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
            Event::NoteOn { hz, velocity, release_at } => {
                // A note that arrives after its own end (a very late message) is dropped rather than blipped.
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
                self.voices[index].start(hz, velocity, release_at, order);
            }
            Event::Param { param, value } => self.apply_param(param, value),
        }
    }

    fn apply_param(&mut self, param: Param, value: f32) {
        match param {
            Param::Waveform => {
                let waveform = Waveform::from_u32(value.max(0.0) as u32);
                self.level = waveform_level(waveform);
                for voice in &mut self.voices {
                    voice.osc.waveform = waveform;
                }
            }
            Param::Sustain => {
                self.params.sustain = value.clamp(0.0, 1.0);
                self.sustain.set_target(self.params.sustain);
            }
            Param::Attack | Param::Decay | Param::Release => {
                let seconds = value.max(0.0);
                match param {
                    Param::Attack => self.params.attack_s = seconds,
                    Param::Decay => self.params.decay_s = seconds,
                    _ => self.params.release_s = seconds,
                }
                let params = AdsrParams { sustain: self.sustain.value(), ..self.params };
                for voice in &mut self.voices {
                    voice.env.set_params(params);
                }
            }
        }
    }

    /// Mono: the voice that sounds (the latest one). Poly: a free voice, else the oldest releasing one, else the oldest.
    fn voice_for_note(&self) -> usize {
        let latest_sounding = || {
            (0..MAX_VOICES).filter(|&i| !self.voices[i].is_idle()).max_by_key(|&i| self.voices[i].order)
        };
        let free = || (0..MAX_VOICES).find(|&i| self.voices[i].is_idle());
        let oldest = |released_only: bool| {
            (0..MAX_VOICES)
                .filter(|&i| !released_only || self.voices[i].release_at == NEVER)
                .min_by_key(|&i| self.voices[i].order)
        };
        if self.mono {
            if let Some(index) = latest_sounding() {
                return index;
            }
        }
        free().or_else(|| oldest(true)).or_else(|| oldest(false)).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;

    const SR: f32 = 48_000.0;

    fn render(synth: &mut Synth, start: i64, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0; frames];
        synth.render(start, &mut out);
        out
    }

    fn rms(buf: &[f32]) -> f32 {
        libm::sqrtf(buf.iter().map(|s| s * s).sum::<f32>() / buf.len() as f32)
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }

    fn estimate_hz(buf: &[f32]) -> f32 {
        let crossings: Vec<f32> = (1..buf.len())
            .filter(|&i| buf[i - 1] < 0.0 && buf[i] >= 0.0)
            .map(|i| i as f32 - buf[i] / (buf[i] - buf[i - 1]))
            .collect();
        SR * (crossings.len() - 1) as f32 / (crossings[crossings.len() - 1] - crossings[0])
    }

    fn first_sound(buf: &[f32]) -> Option<usize> {
        buf.iter().position(|s| *s != 0.0)
    }

    #[test]
    fn silent_without_events() {
        let mut synth = Synth::new(SR);
        let out = render(&mut synth, 0, 1_000);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(synth.render(1_000, &mut [0.0; 128]), 0);
    }

    #[test]
    fn a4_sounds_at_440_hz_with_full_level() {
        let mut synth = Synth::new(SR);
        synth.set_param(0, Param::Sustain as u32, 1.0);
        assert!(synth.note_on(0, 440.0, 1.0, 48_000));
        let out = render(&mut synth, 0, 48_000);
        let body = &out[4_800..43_200];
        let hz = estimate_hz(body);
        assert!((hz - 440.0).abs() < 0.1, "{hz} Hz");
        assert!((peak(body) - 1.0).abs() < 0.01, "peak {}", peak(body));
    }

    #[test]
    fn note_starts_on_its_frame_and_ramps_from_silence() {
        let mut synth = Synth::new(SR);
        synth.set_param(0, Param::Waveform as u32, Waveform::Square as u32 as f32);
        // Frame 1_000 is in the middle of the 8th 128-frame block.
        synth.note_on(1_000, 220.0, 1.0, 4_800);
        let mut out = Vec::new();
        for block in 0..20 {
            out.extend(render(&mut synth, block * 128, 128));
        }
        // Every oscillator starts at phase 0, where it crosses zero, so the first audible sample is the one after.
        assert_eq!(first_sound(&out), Some(1_001));
        // Attack 5 ms (240 frames), linear from 0: even a square wave starts tiny.
        assert!(peak(&out[1_000..1_024]) < 0.11, "{}", peak(&out[1_000..1_024]));
        assert!(peak(&out[1_000..1_120]) < 0.51, "{}", peak(&out[1_000..1_120]));
    }

    #[test]
    fn late_events_apply_at_the_block_start_and_expired_notes_are_dropped() {
        let mut synth = Synth::new(SR);
        synth.note_on(100, 440.0, 1.0, 10_000);
        synth.note_on(0, 440.0, 1.0, 50);
        let out = render(&mut synth, 1_000, 128);
        assert_eq!(first_sound(&out), Some(1));
        assert_eq!(synth.active_voices(), 1);
        assert_eq!(synth.queued_events(), 0);
    }

    #[test]
    fn velocity_scales_the_level() {
        let level = |velocity: f32| {
            let mut synth = Synth::new(SR);
            synth.note_on(0, 440.0, velocity, 48_000);
            rms(&render(&mut synth, 0, 24_000)[4_800..])
        };
        let ratio = level(0.5) / level(1.0);
        assert!((ratio - 0.5).abs() < 0.01, "{ratio}");
    }

    #[test]
    fn note_releases_after_its_duration() {
        let mut synth = Synth::new(SR);
        synth.set_param(0, Param::Release as u32, 0.1);
        synth.note_on(0, 440.0, 1.0, 4_800);
        let out = render(&mut synth, 0, 24_000);
        assert!(peak(&out[4_000..4_800]) > 0.25);
        assert!(peak(&out[9_700..10_000]) < 0.01, "{}", peak(&out[9_700..10_000]));
        assert!(out[10_000..].iter().all(|&s| s == 0.0));
        assert_eq!(synth.active_voices(), 0);
    }

    #[test]
    fn poly_mode_overlaps_notes() {
        let mut synth = Synth::new(SR);
        synth.note_on(0, 440.0, 1.0, 24_000);
        synth.note_on(4_800, 660.0, 1.0, 24_000);
        render(&mut synth, 0, 9_600);
        assert_eq!(synth.active_voices(), 2);
    }

    #[test]
    fn poly_mode_steals_the_oldest_voice() {
        let mut synth = Synth::new(SR);
        for i in 0..MAX_VOICES as i64 {
            synth.note_on(i * 10, 100.0 + i as f32, 1.0, 48_000);
        }
        render(&mut synth, 0, 1_000);
        assert_eq!(synth.active_voices(), MAX_VOICES);
        let oldest = synth.voices.iter().position(|voice| voice.order == 1).unwrap();
        synth.note_on(1_000, 999.0, 1.0, 48_000);
        render(&mut synth, 1_000, 128);
        assert_eq!(synth.active_voices(), MAX_VOICES);
        assert_eq!(synth.voices[oldest].order, MAX_VOICES as u64 + 1);
    }

    #[test]
    fn stealing_prefers_a_releasing_voice() {
        let mut synth = Synth::new(SR);
        synth.note_on(0, 100.0, 1.0, 48_000);
        for i in 1..MAX_VOICES as i64 {
            // Short notes, still ringing (release 1 s) when the next note comes.
            synth.note_on(i * 10, 100.0 + i as f32, 1.0, 100);
        }
        render(&mut synth, 0, 1_000);
        synth.note_on(1_000, 999.0, 1.0, 48_000);
        render(&mut synth, 1_000, 128);
        // The long note (the oldest, still held) survives; the oldest released one (order 2) was taken.
        assert_eq!(synth.voices.iter().filter(|voice| voice.order == 1).count(), 1);
        assert_eq!(synth.voices.iter().filter(|voice| voice.order == 2).count(), 0);
    }

    #[test]
    fn mono_mode_retriggers_one_voice_legato() {
        let mut synth = Synth::new(SR);
        synth.set_mono(true);
        synth.set_param(0, Param::Sustain as u32, 1.0);
        synth.note_on(0, 440.0, 1.0, 48_000);
        synth.note_on(9_600, 660.0, 1.0, 4_800);
        let out = render(&mut synth, 0, 24_000);
        assert_eq!(synth.active_voices(), 1);
        // No jump where the second note takes over.
        let max_step = out[9_500..9_700].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        let allowed = 2.0 * core::f32::consts::PI * 660.0 / SR * 1.05;
        assert!(max_step <= allowed, "step {max_step} > {allowed}");
        // The new pitch sounds, and the second note owns the release: silent well before the first note would have ended.
        let hz = estimate_hz(&out[10_000..14_000]);
        assert!((hz - 660.0).abs() < 1.0, "{hz}");
        // Released at 14_400, silent a release time (1 s) later, long before the first note (48_000 + 1 s).
        let tail = render(&mut synth, 24_000, 48_000);
        assert!(tail[62_400 - 24_000..].iter().all(|&s| s == 0.0));
        assert_eq!(synth.active_voices(), 0);
    }

    #[test]
    fn switching_to_mono_releases_the_other_voices_on_the_next_note() {
        let mut synth = Synth::new(SR);
        synth.note_on(0, 440.0, 1.0, 48_000);
        synth.note_on(10, 550.0, 1.0, 48_000);
        render(&mut synth, 0, 128);
        synth.set_mono(true);
        synth.note_on(200, 660.0, 1.0, 48_000);
        render(&mut synth, 128, 128);
        let held = synth.voices.iter().filter(|voice| !voice.is_idle() && voice.release_at != NEVER).count();
        assert_eq!(held, 1);
    }

    #[test]
    fn timed_params_apply_on_their_frame() {
        let mut synth = Synth::new(SR);
        synth.set_param(0, Param::Sustain as u32, 1.0);
        synth.note_on(0, 440.0, 1.0, 96_000);
        synth.set_param(24_000, Param::Sustain as u32, 0.25);
        let out = render(&mut synth, 0, 48_000);
        assert!((peak(&out[20_000..24_000]) - 1.0).abs() < 0.01);
        assert!((peak(&out[30_000..48_000]) - 0.25).abs() < 0.01, "{}", peak(&out[30_000..48_000]));
        // The level glides: no sample-to-sample jump bigger than the sine's own slope allows.
        let max_step = out[23_900..24_500].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(max_step < 0.07, "{max_step}");
    }

    #[test]
    fn waveform_param_changes_the_sound() {
        let mut synth = Synth::new(SR);
        synth.set_param(0, Param::Sustain as u32, 1.0);
        synth.set_param(0, Param::Waveform as u32, Waveform::Square as u32 as f32);
        synth.note_on(0, 100.0, 1.0, 48_000);
        let out = render(&mut synth, 0, 24_000);
        assert!((rms(&out[4_800..]) - 0.85).abs() < 0.03, "{}", rms(&out[4_800..]));
    }

    #[test]
    fn rejects_bad_input_and_a_full_queue() {
        let mut synth = Synth::new(SR);
        assert!(!synth.note_on(0, f32::NAN, 1.0, 10));
        assert!(!synth.note_on(0, 0.0, 1.0, 10));
        assert!(!synth.set_param(0, 99, 1.0));
        for i in 0..MAX_EVENTS as i64 {
            assert!(synth.set_param(i, Param::Attack as u32, 0.01));
        }
        assert!(!synth.set_param(0, Param::Attack as u32, 0.01));
        assert_eq!(synth.queued_events(), MAX_EVENTS);
    }

    #[test]
    fn same_frame_events_apply_in_arrival_order() {
        let mut synth = Synth::new(SR);
        synth.set_param(0, Param::Sustain as u32, 0.2);
        synth.set_param(0, Param::Sustain as u32, 0.8);
        synth.note_on(0, 440.0, 1.0, 48_000);
        let out = render(&mut synth, 0, 24_000);
        assert!((peak(&out[20_000..]) - 0.8).abs() < 0.01);
    }
}
