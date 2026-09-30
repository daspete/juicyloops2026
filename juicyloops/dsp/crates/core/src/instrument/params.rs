//! The patch: every setting of an `Instrument` as one flat array of f32s, addressed by id. The ids are part of
//! the worklet ABI and mirrored by the frontend (`frontend/src/juicyloops/synths/params.ts`); never renumber one.
//!
//! Sections share ids across models, so the globals, filter, envelopes, LFOs and matrix are one code path. Only
//! the source section (10..=39 and 100..=139) means different things per model.

/// Number of slots in a patch.
pub const PARAM_COUNT: usize = 140;

// ---- globals ----
/// Output level, 0..=1.
pub const VOLUME: u32 = 0;
/// Portamento time in seconds; 0 = off.
pub const GLIDE: u32 = 1;
/// How much velocity sets the level, 0..=1 (0: every note at full level).
pub const VELOCITY: u32 = 2;
/// Pitch bend of every voice in semitones (host; glides a few ms).
pub const BEND: u32 = 3;
/// Mod wheel, 0..=1 (a modulation source).
pub const MOD_WHEEL: u32 = 4;
/// Tempo in BPM, for synced LFOs (host).
pub const TEMPO: u32 = 5;
/// Unison copies of every oscillator, 1..=7.
pub const UNISON: u32 = 6;
/// Unison detune, 0..=1 (the outermost copies at ±50 cents).
pub const UNISON_DETUNE: u32 = 7;
/// Unison stereo spread, 0..=1.
pub const UNISON_SPREAD: u32 = 8;
/// Pan, -1..=1.
pub const PAN: u32 = 9;

// ---- source: analog ----
/// Oscillator `n` (0..3) starts at `OSC + n * OSC_STRIDE`: wave, octave, semitones, cents, level, pulse width.
pub const OSC: u32 = 10;
pub const OSC_STRIDE: u32 = 6;
pub const OSC_WAVE: u32 = 0;
pub const OSC_OCTAVE: u32 = 1;
pub const OSC_SEMI: u32 = 2;
pub const OSC_FINE: u32 = 3;
pub const OSC_LEVEL: u32 = 4;
/// Analog: pulse width 0.05..=0.95. Wavetable: position 0..=1.
pub const OSC_SHAPE: u32 = 5;
/// Wavetable: table number of oscillator `n` (0..2), at the analog wave slot.
pub const WT_TABLE: u32 = OSC_WAVE;
/// Noise level, 0..=1 (analog, wavetable).
pub const NOISE: u32 = 28;
/// Sub oscillator level (a square an octave under oscillator 1), 0..=1 (analog, wavetable).
pub const SUB: u32 = 29;

// ---- source: fm ----
/// Algorithm 0..=7 (see `fm.rs`).
pub const FM_ALGORITHM: u32 = 10;
/// Feedback of the top operator, 0..=1.
pub const FM_FEEDBACK: u32 = 11;
/// Operator `n` (0..4) starts at `OP + n * OP_STRIDE`.
pub const OP: u32 = 100;
pub const OP_STRIDE: u32 = 10;
/// Frequency ratio to the note, 0.25..=16.
pub const OP_RATIO: u32 = 0;
/// Detune in cents, -50..=50.
pub const OP_DETUNE: u32 = 1;
/// Output level, 0..=1 (a carrier's loudness, a modulator's index).
pub const OP_LEVEL: u32 = 2;
pub const OP_ATTACK: u32 = 3;
pub const OP_DECAY: u32 = 4;
pub const OP_SUSTAIN: u32 = 5;
pub const OP_RELEASE: u32 = 6;
/// How much velocity scales the level, 0..=1.
pub const OP_VELOCITY: u32 = 7;

// ---- filter ----
/// `FilterMode` as a number.
pub const FILTER_TYPE: u32 = 40;
/// Hz.
pub const CUTOFF: u32 = 41;
/// 0..=1.
pub const RESONANCE: u32 = 42;
/// 0..=1.
pub const DRIVE: u32 = 43;
/// How far the cutoff follows the note, 0..=1 (1: an octave per octave, around C4).
pub const KEY_TRACK: u32 = 44;
/// Filter envelope depth, -1..=1 (±8 octaves).
pub const FILTER_ENV: u32 = 45;
/// How much softer notes close the filter, 0..=1 (up to 4 octaves at velocity 0).
pub const FILTER_VELOCITY: u32 = 46;

// ---- envelopes: attack s, decay s, sustain level, release s ----
pub const FILTER_ATTACK: u32 = 50;
pub const FILTER_DECAY: u32 = 51;
pub const FILTER_SUSTAIN: u32 = 52;
pub const FILTER_RELEASE: u32 = 53;
pub const AMP_ATTACK: u32 = 54;
pub const AMP_DECAY: u32 = 55;
pub const AMP_SUSTAIN: u32 = 56;
pub const AMP_RELEASE: u32 = 57;

// ---- LFOs: `LFO + n * LFO_STRIDE` (n 0..2) ----
pub const LFO: u32 = 60;
pub const LFO_STRIDE: u32 = 10;
/// `LfoShape` as a number.
pub const LFO_SHAPE: u32 = 0;
/// Hz, when not synced.
pub const LFO_RATE: u32 = 1;
/// 0 free, else an index into `SYNC_BEATS` + 1.
pub const LFO_SYNC: u32 = 2;
/// 1: every note starts the cycle over (per voice). 0: one free-running cycle shared by every voice.
pub const LFO_RETRIGGER: u32 = 3;
/// Destination of the LFO's own slot (`Dest`), and its amount -1..=1.
pub const LFO_DEST: u32 = 4;
pub const LFO_AMOUNT: u32 = 5;
/// Seconds the LFO takes to fade in after a note starts (per-voice LFOs only).
pub const LFO_FADE: u32 = 6;

// ---- modulation matrix: `MATRIX + slot * 3` = source, destination, amount (slot 0..4) ----
pub const MATRIX: u32 = 80;
pub const MATRIX_SLOTS: u32 = 4;

/// Modulation sources.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Source {
    None = 0,
    Lfo1 = 1,
    Lfo2 = 2,
    FilterEnv = 3,
    AmpEnv = 4,
    Velocity = 5,
    ModWheel = 6,
    /// The note around C4, an octave = 1/5 (so -1..=1 spans five octaves either way).
    Key = 7,
    /// A random level per note, -1..=1.
    Random = 8,
}

pub const SOURCE_COUNT: usize = 9;

impl Source {
    pub fn from_f32(value: f32) -> Self {
        match value as u32 {
            1 => Source::Lfo1,
            2 => Source::Lfo2,
            3 => Source::FilterEnv,
            4 => Source::AmpEnv,
            5 => Source::Velocity,
            6 => Source::ModWheel,
            7 => Source::Key,
            8 => Source::Random,
            _ => Source::None,
        }
    }
}

/// Modulation destinations. "A" and "B" mean oscillator 1 and 2 (analog, wavetable); for FM, pitch A is every
/// modulator, pitch B operator 4, shape A the modulators' levels (brightness), shape B the feedback, level B the
/// carriers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Dest {
    None = 0,
    /// ±12 semitones at full amount, every oscillator.
    Pitch = 1,
    PitchA = 2,
    PitchB = 3,
    /// Pulse width / table position / modulator level: ±the whole range.
    ShapeA = 4,
    ShapeB = 5,
    /// ±6 octaves.
    Cutoff = 6,
    Resonance = 7,
    /// Level ×(1 + amount), so -1 silences.
    Volume = 8,
    Pan = 9,
    /// ×2^(±3 octaves).
    Lfo1Rate = 10,
    Lfo2Rate = 11,
    Noise = 12,
    LevelB = 13,
    Drive = 14,
}

pub const DEST_COUNT: usize = 15;

impl Dest {
    pub fn from_f32(value: f32) -> Self {
        match value as u32 {
            1 => Dest::Pitch,
            2 => Dest::PitchA,
            3 => Dest::PitchB,
            4 => Dest::ShapeA,
            5 => Dest::ShapeB,
            6 => Dest::Cutoff,
            7 => Dest::Resonance,
            8 => Dest::Volume,
            9 => Dest::Pan,
            10 => Dest::Lfo1Rate,
            11 => Dest::Lfo2Rate,
            12 => Dest::Noise,
            13 => Dest::LevelB,
            14 => Dest::Drive,
            _ => Dest::None,
        }
    }
}

/// Which sound source a patch drives. The numbers are the worklet's `init` kinds minus one (0 is the classic synth).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Model {
    Analog,
    Wavetable,
    Fm,
}

#[derive(Clone, Debug)]
pub struct Patch {
    values: [f32; PARAM_COUNT],
}

impl Patch {
    /// The patch every new instrument starts with: one saw through an open low-pass, a short pluck-free envelope.
    pub fn new(model: Model) -> Self {
        let mut values = [0.0; PARAM_COUNT];
        let mut set = |id: u32, value: f32| values[id as usize] = value;
        set(VOLUME, 0.7);
        set(VELOCITY, 1.0);
        set(TEMPO, 120.0);
        set(UNISON, 1.0);
        set(UNISON_DETUNE, 0.2);
        set(UNISON_SPREAD, 0.5);
        for n in 0..3 {
            let base = OSC + n * OSC_STRIDE;
            set(base + OSC_WAVE, if model == Model::Analog { 2.0 } else { 0.0 });
            set(base + OSC_LEVEL, if n == 0 { 1.0 } else { 0.0 });
            set(base + OSC_SHAPE, if model == Model::Analog { 0.5 } else { 0.0 });
        }
        if model == Model::Fm {
            set(FM_ALGORITHM, 0.0);
            for n in 0..4 {
                let base = OP + n * OP_STRIDE;
                set(base + OP_RATIO, 1.0);
                set(base + OP_LEVEL, if n < 2 { 1.0 } else { 0.0 });
                set(base + OP_ATTACK, 0.005);
                set(base + OP_DECAY, 0.5);
                set(base + OP_SUSTAIN, if n == 0 { 1.0 } else { 0.4 });
                set(base + OP_RELEASE, 0.3);
                set(base + OP_VELOCITY, if n == 0 { 0.0 } else { 0.5 });
            }
        }
        set(FILTER_TYPE, if model == Model::Fm { 0.0 } else { 1.0 });
        set(CUTOFF, 20_000.0);
        set(FILTER_ATTACK, 0.005);
        set(FILTER_DECAY, 0.3);
        set(FILTER_SUSTAIN, 0.5);
        set(FILTER_RELEASE, 0.3);
        set(AMP_ATTACK, 0.005);
        set(AMP_DECAY, 0.1);
        set(AMP_SUSTAIN, 0.8);
        set(AMP_RELEASE, 0.3);
        for n in 0..2 {
            let base = LFO + n * LFO_STRIDE;
            set(base + LFO_RATE, if n == 0 { 5.0 } else { 0.5 });
            set(base + LFO_RETRIGGER, 1.0);
        }
        Self { values }
    }

    #[inline]
    pub fn get(&self, id: u32) -> f32 {
        self.values.get(id as usize).copied().unwrap_or(0.0)
    }

    /// Stores a value; false for an id outside the patch.
    pub fn set(&mut self, id: u32, value: f32) -> bool {
        match self.values.get_mut(id as usize) {
            Some(slot) => {
                *slot = value;
                true
            }
            None => false,
        }
    }

    #[inline]
    pub fn osc(&self, n: u32, field: u32) -> f32 {
        self.get(OSC + n * OSC_STRIDE + field)
    }

    #[inline]
    pub fn op(&self, n: u32, field: u32) -> f32 {
        self.get(OP + n * OP_STRIDE + field)
    }

    #[inline]
    pub fn lfo(&self, n: u32, field: u32) -> f32 {
        self.get(LFO + n * LFO_STRIDE + field)
    }
}
