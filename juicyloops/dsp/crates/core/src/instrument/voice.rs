//! One voice of an `Instrument`: a generator (the model's oscillators), a filter (two in stereo), amp and filter
//! envelopes, two LFOs, and the modulation that ties them together.
//!
//! Modulation runs at control rate: the instrument renders in blocks of at most `CONTROL_BLOCK` frames and every
//! block starts by evaluating the sources and the matrix. Filter coefficients and output gains glide linearly
//! across the block, so nothing steps audibly.

use super::analog::AnalogSource;
use super::fm::FmSource;
use super::params::*;
use super::wavetable::{WavetableBank, WavetableSource};
use crate::filter::{cutoff_gain, Filter, FilterMode};
use crate::lfo::{lfo_rate, Lfo, LfoShape};
use crate::math::Rng;
use crate::{Adsr, AdsrParams};

/// Longest stretch a voice renders with one set of modulation values.
pub const CONTROL_BLOCK: usize = 16;
/// Unison copies at most.
pub const MAX_UNISON: usize = 7;

/// What every generator gets for one control block.
#[derive(Clone, Copy, Debug, Default)]
pub struct SourceControl {
    /// The note as a (fractional) MIDI number, with bend, glide and pitch modulation applied.
    pub note: f32,
    /// Extra semitones for oscillator A and B.
    pub pitch_a: f32,
    pub pitch_b: f32,
    /// Added to the shape of A and B (pulse width, table position, modulator level / feedback).
    pub shape_a: f32,
    pub shape_b: f32,
    /// Added to the level of B, and to the noise level.
    pub level_b: f32,
    pub noise: f32,
    /// The note's velocity, 0..=1.
    pub velocity: f32,
}

/// Everything a generator may read that belongs to the whole instrument.
pub struct Shared<'a> {
    pub sample_rate: f32,
    pub patch: &'a Patch,
    pub tables: &'a WavetableBank,
}

/// The model's sound source.
#[derive(Clone, Debug)]
pub enum Generator {
    Analog(AnalogSource),
    Wavetable(WavetableSource),
    Fm(FmSource),
}

impl Generator {
    pub fn new(model: Model, seed: u32) -> Self {
        match model {
            Model::Analog => Generator::Analog(AnalogSource::new(seed)),
            Model::Wavetable => Generator::Wavetable(WavetableSource::new(seed)),
            Model::Fm => Generator::Fm(FmSource::new()),
        }
    }

    /// A note starts; `fresh` when the voice was silent (else a legato takeover).
    fn start(&mut self, shared: &Shared, fresh: bool, velocity: f32) {
        match self {
            Generator::Analog(source) => source.start(shared, fresh),
            Generator::Wavetable(source) => source.start(shared, fresh),
            Generator::Fm(source) => source.start(shared, fresh, velocity),
        }
    }

    fn release(&mut self) {
        if let Generator::Fm(source) = self {
            source.release();
        }
    }

    /// Writes (not adds) one control block. Returns true when it wrote stereo into both buffers, false when
    /// it wrote mono into `left` only.
    fn render(&mut self, shared: &Shared, control: &SourceControl, left: &mut [f32], right: &mut [f32]) -> bool {
        match self {
            Generator::Analog(source) => source.render(shared, control, left, right),
            Generator::Wavetable(source) => source.render(shared, control, left, right),
            Generator::Fm(source) => source.render(shared, control, left, right),
        }
    }

    /// Envelope settings of the generator changed (FM operators).
    pub fn update(&mut self, shared: &Shared) {
        if let Generator::Fm(source) = self {
            source.update(shared);
        }
    }
}

/// What a voice needs from the instrument for one control block.
pub struct BlockContext<'a> {
    pub shared: Shared<'a>,
    /// Bend in semitones (already glided).
    pub bend: f32,
    /// Fraction of the way to the target pitch a gliding voice covers in this block (1 without glide).
    pub glide: f32,
    /// The shared free-running LFOs' levels.
    pub free_lfo: [f32; 2],
}

#[derive(Clone, Debug)]
pub struct Voice {
    pub generator: Generator,
    pub amp: Adsr,
    pub filter_env: Adsr,
    filters: [Filter; 2],
    lfos: [Lfo; 2],
    /// Seconds since the note started, for LFO fade-in.
    age: f32,
    /// LFO rate modulation from the previous block (the LFOs feed the matrix that may modulate them).
    rate_mod: [f32; 2],
    /// Output gains at the end of the previous block, where the next one glides from.
    gains: (f32, f32),
    rng: Rng,
    velocity: f32,
    random: f32,
    /// The note (MIDI number) the voice plays, and where its pitch is while it glides there.
    pub key: f32,
    pub pitch: f32,
    /// When the voice was (re)started, for stealing and for finding the mono voice.
    pub order: u64,
    /// Absolute frame the gate closes at, `i64::MAX` when none is scheduled.
    pub release_at: i64,
    pub gate: bool,
    /// The id of the note it plays, for `note_off`; 0 for scheduled notes.
    pub id: u32,
}

pub fn amp_params(patch: &Patch) -> AdsrParams {
    AdsrParams {
        attack_s: patch.get(AMP_ATTACK).max(0.0),
        decay_s: patch.get(AMP_DECAY).max(0.0),
        sustain: patch.get(AMP_SUSTAIN),
        release_s: patch.get(AMP_RELEASE).max(0.0),
    }
}

pub fn filter_env_params(patch: &Patch) -> AdsrParams {
    AdsrParams {
        attack_s: patch.get(FILTER_ATTACK).max(0.0),
        decay_s: patch.get(FILTER_DECAY).max(0.0),
        sustain: patch.get(FILTER_SUSTAIN),
        release_s: patch.get(FILTER_RELEASE).max(0.0),
    }
}

impl Voice {
    pub fn new(model: Model, sample_rate: f32, patch: &Patch, seed: u32) -> Self {
        Self {
            generator: Generator::new(model, seed.wrapping_mul(0x2545_f491)),
            amp: Adsr::new(sample_rate, amp_params(patch)),
            filter_env: Adsr::new(sample_rate, filter_env_params(patch)),
            filters: [Filter::new(), Filter::new()],
            lfos: [Lfo::new(seed.wrapping_add(11)), Lfo::new(seed.wrapping_add(23))],
            age: 0.0,
            rate_mod: [0.0; 2],
            gains: (0.0, 0.0),
            rng: Rng::new(seed.wrapping_add(1)),
            velocity: 0.0,
            random: 0.0,
            key: 60.0,
            pitch: 60.0,
            order: 0,
            release_at: i64::MAX,
            gate: false,
            id: 0,
        }
    }

    pub fn is_idle(&self) -> bool {
        self.amp.is_idle()
    }

    /// Starts a note. `from` is where the pitch glides from (the previous note), or None to start on the note.
    pub fn start(&mut self, shared: &Shared, id: u32, key: f32, velocity: f32, from: Option<f32>, release_at: i64, order: u64) {
        let fresh = self.is_idle();
        let patch = shared.patch;
        if fresh {
            self.age = 0.0;
            self.gains = (0.0, 0.0);
            self.rate_mod = [0.0; 2];
            let g = cutoff_gain(patch.get(CUTOFF), shared.sample_rate);
            let res = patch.get(RESONANCE);
            for filter in &mut self.filters {
                filter.reset(g, res);
            }
            self.pitch = from.unwrap_or(key);
        } else if from.is_none() {
            self.pitch = key;
        }
        for n in 0..2 {
            if fresh && patch.lfo(n, LFO_RETRIGGER) >= 0.5 {
                self.lfos[n as usize].reset(0.0);
            }
        }
        self.random = self.rng.bipolar();
        self.key = key;
        self.velocity = velocity;
        self.generator.start(shared, fresh, velocity);
        self.amp.gate_on();
        self.filter_env.gate_on();
        self.release_at = release_at;
        self.gate = true;
        self.id = id;
        self.order = order;
    }

    pub fn release(&mut self) {
        self.amp.gate_off();
        self.filter_env.gate_off();
        self.generator.release();
        self.release_at = i64::MAX;
        self.gate = false;
    }

    /// Renders one control block (at most `CONTROL_BLOCK` frames) and adds it to `out_l`/`out_r`.
    pub fn render_add(&mut self, cx: &BlockContext, scratch: &mut [[f32; CONTROL_BLOCK]; 2], out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len();
        if self.is_idle() || n == 0 {
            return;
        }
        let shared = &cx.shared;
        let patch = shared.patch;
        let sr = shared.sample_rate;
        let seconds = n as f32 / sr;

        // Glide towards the note.
        self.pitch += (self.key - self.pitch) * cx.glide;

        // Sources.
        let mut lfo = [0.0f32; 2];
        for i in 0..2 {
            let n_lfo = i as u32;
            let shape = LfoShape::from_u32(patch.lfo(n_lfo, LFO_SHAPE) as u32);
            if patch.lfo(n_lfo, LFO_RETRIGGER) >= 0.5 {
                let fade = patch.lfo(n_lfo, LFO_FADE);
                let depth = if fade > 0.0 { (self.age / fade).min(1.0) } else { 1.0 };
                lfo[i] = self.lfos[i].value(shape) * depth;
                let rate = lfo_rate(patch.lfo(n_lfo, LFO_RATE), patch.lfo(n_lfo, LFO_SYNC) as u32, patch.get(TEMPO));
                self.lfos[i].advance(rate * libm::exp2f(3.0 * self.rate_mod[i]) * seconds);
            } else {
                lfo[i] = cx.free_lfo[i];
            }
        }
        let mut filter_env = 0.0;
        for _ in 0..n {
            filter_env = self.filter_env.next_sample();
        }
        self.age += seconds;
        let mut sources = [0.0f32; SOURCE_COUNT];
        sources[Source::Lfo1 as usize] = lfo[0];
        sources[Source::Lfo2 as usize] = lfo[1];
        sources[Source::FilterEnv as usize] = filter_env;
        sources[Source::AmpEnv as usize] = self.amp.value();
        sources[Source::Velocity as usize] = self.velocity;
        sources[Source::ModWheel as usize] = patch.get(MOD_WHEEL);
        sources[Source::Key as usize] = (self.key - 60.0) / 60.0;
        sources[Source::Random as usize] = self.random;

        // The matrix: each LFO's own slot, then the free slots.
        let mut mods = [0.0f32; DEST_COUNT];
        for i in 0..2u32 {
            let dest = Dest::from_f32(patch.lfo(i, LFO_DEST));
            mods[dest as usize] += lfo[i as usize] * patch.lfo(i, LFO_AMOUNT);
        }
        for slot in 0..MATRIX_SLOTS {
            let base = MATRIX + slot * 3;
            let source = Source::from_f32(patch.get(base));
            let dest = Dest::from_f32(patch.get(base + 1));
            mods[dest as usize] += sources[source as usize] * patch.get(base + 2);
        }
        mods[Dest::None as usize] = 0.0;
        self.rate_mod = [mods[Dest::Lfo1Rate as usize], mods[Dest::Lfo2Rate as usize]];

        // The generator.
        let control = SourceControl {
            note: self.pitch + cx.bend + 12.0 * mods[Dest::Pitch as usize],
            pitch_a: 12.0 * mods[Dest::PitchA as usize],
            pitch_b: 12.0 * mods[Dest::PitchB as usize],
            shape_a: mods[Dest::ShapeA as usize],
            shape_b: mods[Dest::ShapeB as usize],
            level_b: mods[Dest::LevelB as usize],
            noise: mods[Dest::Noise as usize],
            velocity: self.velocity,
        };
        let [left, right] = scratch;
        let (left, right) = (&mut left[..n], &mut right[..n]);
        let stereo = self.generator.render(shared, &control, left, right);

        // The filter.
        let mode = FilterMode::from_u32(patch.get(FILTER_TYPE) as u32);
        let octaves = libm::log2f(patch.get(CUTOFF).max(1.0))
            + patch.get(KEY_TRACK) * (self.key - 60.0) / 12.0
            + 8.0 * patch.get(FILTER_ENV) * filter_env
            + 4.0 * patch.get(FILTER_VELOCITY) * (self.velocity - 1.0)
            + 6.0 * mods[Dest::Cutoff as usize];
        let g = cutoff_gain(libm::exp2f(octaves.clamp(0.0, 15.0)), sr);
        let res = (patch.get(RESONANCE) + mods[Dest::Resonance as usize]).clamp(0.0, 1.0);
        let drive = (patch.get(DRIVE) + mods[Dest::Drive as usize]).clamp(0.0, 1.0);
        self.filters[0].set_mode(mode);
        self.filters[0].process(left, g, res, drive);
        if stereo {
            self.filters[1].set_mode(mode);
            self.filters[1].process(right, g, res, drive);
        }

        // Level and pan, gliding across the block.
        let sensitivity = patch.get(VELOCITY).clamp(0.0, 1.0);
        let level = patch.get(VOLUME).max(0.0) * (1.0 - sensitivity + sensitivity * self.velocity) * (1.0 + mods[Dest::Volume as usize]).max(0.0);
        let pan = (patch.get(PAN) + mods[Dest::Pan as usize]).clamp(-1.0, 1.0);
        let target = (level * (1.0 - pan).min(1.0), level * (1.0 + pan).min(1.0));
        let (mut gl, mut gr) = self.gains;
        let step = 1.0 / n as f32;
        let (dl, dr) = ((target.0 - gl) * step, (target.1 - gr) * step);
        for i in 0..n {
            gl += dl;
            gr += dr;
            let env = self.amp.next_sample();
            let r = if stereo { right[i] } else { left[i] };
            out_l[i] += left[i] * env * gl;
            out_r[i] += r * env * gr;
        }
        self.gains = target;
    }

}
