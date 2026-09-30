//! The wavetable model's generator and its tables.
//!
//! A table is `FRAMES` single-cycle frames that morph from one to the next; the oscillator's position picks the
//! pair of neighbouring frames and crossfades them. The eight built-in tables (`TABLE_NAMES`) are generated here:
//! each frame is drawn at `FRAME_SIZE` samples (in the time domain, or straight as a spectrum), transformed, and
//! stored as band-limited mipmaps, one level per octave, so a frame never carries harmonics above Nyquist for the
//! pitches its level serves. Lower levels hold fewer harmonics and are shorter (always at least 4× oversampled).
//!
//! The bank holds only the two tables the oscillators play. `new(true)` allocates everything up front (the wasm
//! allocator never frees); `select` regenerates a slot in place, on the audio thread, in about a millisecond.

use super::analog::{unison_gain, unison_spread, wave_sample};
use super::params::*;
use super::voice::{Shared, SourceControl, MAX_UNISON};
use crate::fft::Fft;
use crate::math::{note_to_hz, semitones_ratio, sin_turns, soft_clip, Rng};
use alloc::boxed::Box;
use alloc::vec;
use alloc::vec::Vec;

/// Frames per table.
pub const FRAMES: usize = 16;
/// Samples a frame is drawn with before it is band-limited.
pub const FRAME_SIZE: usize = 2048;
/// Built-in tables, in `WT_TABLE` order.
pub const TABLE_NAMES: [&str; 8] = ["Basic", "PWM", "Organ", "Vox", "Sync", "Fold", "Bell", "Growl"];
pub const TABLE_COUNT: u32 = TABLE_NAMES.len() as u32;

/// Mip levels per frame.
const LEVELS: usize = 10;
/// Harmonics of the top level; level `k` keeps `TOP_HARMONICS >> k`.
const TOP_HARMONICS: usize = 512;

const fn level_harmonics(k: usize) -> usize {
    TOP_HARMONICS >> k
}

/// Samples of level `k`: four per harmonic, 64 at least, `FRAME_SIZE` at most.
const fn level_len(k: usize) -> usize {
    let len = 4 * level_harmonics(k);
    if len < 64 {
        64
    } else if len > FRAME_SIZE {
        FRAME_SIZE
    } else {
        len
    }
}

/// Where each level starts inside a frame. Every level stores one guard sample (a copy of its first) after its end.
const LEVEL_OFFSETS: [usize; LEVELS] = {
    let mut offsets = [0; LEVELS];
    let mut k = 1;
    while k < LEVELS {
        offsets[k] = offsets[k - 1] + level_len(k - 1) + 1;
        k += 1;
    }
    offsets
};

/// Floats per frame, all levels with their guard samples.
const FRAME_STRIDE: usize = LEVEL_OFFSETS[LEVELS - 1] + level_len(LEVELS - 1) + 1;
/// Floats per slot (one table).
const SLOT_LEN: usize = FRAMES * FRAME_STRIDE;

/// The mip level for a playback frequency: the richest one whose top harmonic stays below Nyquist.
#[inline]
fn level_for(hz: f32, sample_rate: f32) -> usize {
    let allowed = 0.5 * sample_rate / hz.max(1.0);
    let k = libm::ceilf(libm::log2f(TOP_HARMONICS as f32 / allowed));
    if k <= 0.0 { 0 } else { (k as usize).min(LEVELS - 1) }
}

/// Working memory for generating a table.
struct Scratch {
    fft: Fft,
    time: Vec<f32>,
    /// The frame's spectrum, bins `0..=FRAME_SIZE/2`.
    re: Vec<f32>,
    im: Vec<f32>,
    /// One level's spectrum.
    level_re: Vec<f32>,
    level_im: Vec<f32>,
    work_re: Vec<f32>,
    work_im: Vec<f32>,
}

pub struct WavetableBank {
    /// The table each slot holds, `u32::MAX` for none yet.
    tables: [u32; 2],
    data: [Vec<f32>; 2],
    scratch: Option<Box<Scratch>>,
}

impl WavetableBank {
    /// `enabled` false for the other models: no memory, no tables.
    pub fn new(enabled: bool) -> Self {
        if !enabled {
            return Self { tables: [u32::MAX; 2], data: [Vec::new(), Vec::new()], scratch: None };
        }
        let half = FRAME_SIZE / 2;
        let scratch = Scratch {
            fft: Fft::new(FRAME_SIZE),
            time: vec![0.0; FRAME_SIZE],
            re: vec![0.0; half + 1],
            im: vec![0.0; half + 1],
            level_re: vec![0.0; half + 1],
            level_im: vec![0.0; half + 1],
            work_re: vec![0.0; half],
            work_im: vec![0.0; half],
        };
        Self { tables: [u32::MAX; 2], data: [vec![0.0; SLOT_LEN], vec![0.0; SLOT_LEN]], scratch: Some(Box::new(scratch)) }
    }

    /// Makes table `table` the one oscillator `slot` (0 or 1) plays.
    pub fn select(&mut self, slot: u32, table: u32) {
        let table = table.min(TABLE_COUNT - 1);
        let slot = slot as usize;
        let Some(scratch) = self.scratch.as_deref_mut() else { return };
        if slot >= 2 || self.tables[slot] == table {
            return;
        }
        self.tables[slot] = table;
        let data = &mut self.data[slot];
        for frame in 0..FRAMES {
            let position = frame as f32 / (FRAMES - 1) as f32;
            build_frame(scratch, table, position, &mut data[frame * FRAME_STRIDE..(frame + 1) * FRAME_STRIDE]);
        }
    }

    /// The table slot `slot` holds, if any.
    pub fn table(&self, slot: u32) -> Option<u32> {
        self.tables.get(slot as usize).copied().filter(|&t| t != u32::MAX)
    }

    /// Level `level` of frame `frame` in slot `slot`, `level_len(level) + 1` samples (the last repeats the first).
    #[inline]
    fn level(&self, slot: usize, frame: usize, level: usize) -> &[f32] {
        let start = frame * FRAME_STRIDE + LEVEL_OFFSETS[level];
        &self.data[slot][start..start + level_len(level) + 1]
    }

    fn is_ready(&self, slot: usize) -> bool {
        self.tables[slot] != u32::MAX
    }
}

/// Draws one frame of `table` at `position` (0..=1) into `scratch.time`, or straight into `scratch.re`/`im`;
/// returns true in the second case.
fn draw_frame(scratch: &mut Scratch, table: u32, position: f32) -> bool {
    let n = FRAME_SIZE;
    let t = position;
    let time = &mut scratch.time;
    // A saw in phase with the sine (falling, crossing zero upwards at 0), so crossfades do not cancel.
    let saw = |p: f32| if p == 0.0 { 0.0 } else { 1.0 - 2.0 * p };
    match table {
        // Basic: sine → triangle → saw → square.
        0 => {
            let seg = t * 3.0;
            for (i, x) in time.iter_mut().enumerate() {
                let p = i as f32 / n as f32;
                let sine = sin_turns(p);
                let tri = if p < 0.25 {
                    4.0 * p
                } else if p < 0.75 {
                    2.0 - 4.0 * p
                } else {
                    4.0 * p - 4.0
                };
                let square = if p == 0.0 || p == 0.5 { 0.0 } else if p < 0.5 { 1.0 } else { -1.0 };
                *x = if seg < 1.0 {
                    sine + (tri - sine) * seg
                } else if seg < 2.0 {
                    tri + (saw(p) - tri) * (seg - 1.0)
                } else {
                    saw(p) + (square - saw(p)) * (seg - 2.0)
                };
            }
            false
        }
        // PWM: pulse width 50% → 5%.
        1 => {
            let width = 0.5 - 0.45 * t;
            for (i, x) in time.iter_mut().enumerate() {
                let p = i as f32 / n as f32;
                *x = if p < width { 1.0 } else { -1.0 };
            }
            false
        }
        // Organ: drawbars (harmonics 1, 2, 3, 4, 5, 6, 8, 10, 12, 16) pulled out one after another.
        2 => {
            const BARS: [(usize, f32); 10] = [(1, 1.0), (2, 0.8), (3, 0.7), (4, 0.6), (5, 0.5), (6, 0.5), (8, 0.4), (10, 0.35), (12, 0.3), (16, 0.25)];
            clear_spectrum(scratch);
            let pulled = 1.0 + t * (BARS.len() - 1) as f32;
            for (j, &(harmonic, amp)) in BARS.iter().enumerate() {
                let weight = (pulled - j as f32).clamp(0.0, 1.0);
                add_sine(scratch, harmonic, amp * weight);
            }
            true
        }
        // Vox: a saw-like spectrum shaped by three formants moving through the vowels a, e, i, o, u.
        3 => {
            const VOWELS: [[f32; 3]; 5] = [[800.0, 1_200.0, 2_500.0], [400.0, 2_000.0, 2_550.0], [270.0, 2_300.0, 3_000.0], [450.0, 800.0, 2_830.0], [325.0, 700.0, 2_530.0]];
            const GAINS: [f32; 3] = [1.0, 0.7, 0.4];
            const WIDTHS: [f32; 3] = [90.0, 120.0, 160.0];
            // The frame's fundamental stands for 110 Hz, where the vowels read best.
            const F0: f32 = 110.0;
            clear_spectrum(scratch);
            let seg = t * (VOWELS.len() - 1) as f32;
            let from = (seg as usize).min(VOWELS.len() - 2);
            let blend = seg - from as f32;
            for h in 1..=TOP_HARMONICS {
                let hz = h as f32 * F0;
                let mut amp = 0.05;
                for f in 0..3 {
                    let centre = VOWELS[from][f] + (VOWELS[from + 1][f] - VOWELS[from][f]) * blend;
                    let d = (hz - centre) / WIDTHS[f];
                    amp += GAINS[f] / (1.0 + d * d);
                }
                add_sine(scratch, h, amp / libm::sqrtf(h as f32));
            }
            true
        }
        // Sync: a saw hard-synced to the frame, its own pitch sweeping from 1× to 8×.
        4 => {
            let ratio = libm::exp2f(3.0 * t);
            for (i, x) in time.iter_mut().enumerate() {
                let p = i as f32 / n as f32;
                let q = p * ratio;
                *x = 1.0 - 2.0 * (q - libm::floorf(q));
            }
            false
        }
        // Fold: a sine driven ever harder into a sine folder.
        5 => {
            let gain = 1.0 + 7.0 * t;
            for (i, x) in time.iter_mut().enumerate() {
                let p = i as f32 / n as f32;
                *x = sin_turns(0.25 * gain * sin_turns(p));
            }
            false
        }
        // Bell: two-operator FM (modulator at 3×), the index rising from 0 to 6.
        6 => {
            let index = 6.0 * t;
            for (i, x) in time.iter_mut().enumerate() {
                let p = i as f32 / n as f32;
                *x = sin_turns(p + index / core::f32::consts::TAU * sin_turns(3.0 * p));
            }
            false
        }
        // Growl: a sine with a growing second harmonic, pushed ever harder into a soft clipper.
        _ => {
            let drive = 1.0 + 19.0 * t * t;
            for (i, x) in time.iter_mut().enumerate() {
                let p = i as f32 / n as f32;
                *x = soft_clip(drive * (sin_turns(p) + 0.5 * t * sin_turns(2.0 * p)));
            }
            false
        }
    }
}

fn clear_spectrum(scratch: &mut Scratch) {
    scratch.re.fill(0.0);
    scratch.im.fill(0.0);
}

/// Adds `amp · sin(2π·harmonic·p)` to the frame's spectrum.
fn add_sine(scratch: &mut Scratch, harmonic: usize, amp: f32) {
    if harmonic <= FRAME_SIZE / 2 {
        scratch.im[harmonic] -= amp * (FRAME_SIZE / 2) as f32;
    }
}

/// Draws, transforms and stores every mip level of one frame into `out` (`FRAME_STRIDE` floats).
fn build_frame(scratch: &mut Scratch, table: u32, position: f32, out: &mut [f32]) {
    if !draw_frame(scratch, table, position) {
        let Scratch { fft, time, re, im, work_re, work_im, .. } = scratch;
        fft.real_forward(time, re, im, work_re, work_im);
    }
    scratch.re[0] = 0.0;
    scratch.im[0] = 0.0;
    let mut gain = 1.0;
    for k in 0..LEVELS {
        let len = level_len(k);
        let harmonics = level_harmonics(k).min(len / 2 - 1);
        let scale = gain * len as f32 / FRAME_SIZE as f32;
        let Scratch { fft, re, im, level_re, level_im, work_re, work_im, .. } = scratch;
        let bins = len / 2 + 1;
        level_re[..bins].fill(0.0);
        level_im[..bins].fill(0.0);
        for h in 1..=harmonics {
            level_re[h] = re[h] * scale;
            level_im[h] = im[h] * scale;
        }
        let level = &mut out[LEVEL_OFFSETS[k]..LEVEL_OFFSETS[k] + len + 1];
        fft.real_inverse(&level_re[..bins], &level_im[..bins], &mut level[..len], work_re, work_im);
        if k == 0 {
            // Normalize the frame to a peak of 1 at its richest level; the others follow with the same gain.
            let peak = level[..len].iter().fold(0.0f32, |m, x| m.max(x.abs()));
            gain = if peak > 1e-6 { 1.0 / peak } else { 0.0 };
            for x in &mut level[..len] {
                *x *= gain;
            }
        }
        level[len] = level[0];
    }
}

#[derive(Clone, Debug)]
pub struct WavetableSource {
    phases: [[f32; MAX_UNISON]; 2],
    sub: f32,
    rng: Rng,
}

impl WavetableSource {
    pub fn new(seed: u32) -> Self {
        Self { phases: [[0.0; MAX_UNISON]; 2], sub: 0.0, rng: Rng::new(seed) }
    }

    pub fn start(&mut self, shared: &Shared, fresh: bool) {
        if !fresh {
            return;
        }
        // Like the analog oscillators: one copy starts on phase 0, stacked copies anywhere.
        let stacked = shared.patch.get(UNISON) >= 1.5;
        for osc in &mut self.phases {
            for phase in osc.iter_mut() {
                *phase = if stacked { self.rng.unit() } else { 0.0 };
            }
        }
        self.sub = 0.0;
    }

    pub fn render(&mut self, shared: &Shared, control: &SourceControl, left: &mut [f32], right: &mut [f32]) -> bool {
        let patch = shared.patch;
        let sr = shared.sample_rate;
        let bank = shared.tables;
        let count = (patch.get(UNISON) as usize).clamp(1, MAX_UNISON);
        let detune = patch.get(UNISON_DETUNE).clamp(0.0, 1.0);
        let spread = patch.get(UNISON_SPREAD).clamp(0.0, 1.0);
        let stereo = count > 1 && spread > 0.0;
        left.fill(0.0);
        if stereo {
            right.fill(0.0);
        }
        let copy_gain = unison_gain(count);
        let mut osc1_hz = 0.0;
        for osc in 0..2u32 {
            let slot = osc as usize;
            let note = control.note
                + 12.0 * patch.osc(osc, OSC_OCTAVE)
                + patch.osc(osc, OSC_SEMI)
                + patch.osc(osc, OSC_FINE) / 100.0
                + if osc == 0 { control.pitch_a } else { control.pitch_b };
            let hz = note_to_hz(note);
            if osc == 0 {
                osc1_hz = hz;
            }
            let level = (patch.osc(osc, OSC_LEVEL) + if osc == 1 { control.level_b } else { 0.0 }).clamp(0.0, 1.0);
            if level <= 0.0 || !bank.is_ready(slot) {
                continue;
            }
            let shape_mod = if osc == 0 { control.shape_a } else { control.shape_b };
            let position = (patch.osc(osc, OSC_SHAPE) + shape_mod).clamp(0.0, 1.0) * (FRAMES - 1) as f32;
            let frame = (position as usize).min(FRAMES - 2);
            let mix = position - frame as f32;
            // The upper copies are detuned up to half a semitone: pick the level for the highest.
            let top = if count > 1 { hz * semitones_ratio(detune * 0.5) } else { hz };
            let mip = level_for(top, sr);
            let len = level_len(mip);
            let a = bank.level(slot, frame, mip);
            let b = bank.level(slot, frame + 1, mip);
            let gain = level * copy_gain;
            for copy in 0..count {
                let (cents, pan) = unison_spread(copy, count, detune, spread);
                let dt = (hz * semitones_ratio(cents) / sr).clamp(0.0, 0.49);
                let mut t = self.phases[slot][copy];
                let (gl, gr) = if stereo { (gain * (1.0 - pan).min(1.0), gain * (1.0 + pan).min(1.0)) } else { (gain, 0.0) };
                for i in 0..left.len() {
                    let x = t * len as f32;
                    let j = (x as usize).min(len - 1);
                    let frac = x - j as f32;
                    let sa = a[j] + (a[j + 1] - a[j]) * frac;
                    let sb = b[j] + (b[j + 1] - b[j]) * frac;
                    let s = sa + (sb - sa) * mix;
                    left[i] += s * gl;
                    if stereo {
                        right[i] += s * gr;
                    }
                    t += dt;
                    if t >= 1.0 {
                        t -= 1.0;
                    }
                }
                self.phases[slot][copy] = t;
            }
        }

        let sub = patch.get(SUB).clamp(0.0, 1.0);
        let noise = (patch.get(NOISE) + control.noise).clamp(0.0, 1.0);
        if sub > 0.0 || noise > 0.0 {
            let dt = (osc1_hz * 0.5 / sr).clamp(0.0, 0.49);
            for i in 0..left.len() {
                let mut s = 0.0;
                if sub > 0.0 {
                    s += wave_sample(3, self.sub, dt, 0.5) * sub;
                    self.sub += dt;
                    if self.sub >= 1.0 {
                        self.sub -= 1.0;
                    }
                }
                if noise > 0.0 {
                    s += self.rng.bipolar() * noise;
                }
                left[i] += s;
                if stereo {
                    right[i] += s;
                }
            }
        }
        stereo
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use crate::instrument::Instrument;

    const SR: f32 = 48_000.0;

    fn instrument(table: u32, position: f32) -> Instrument {
        let mut inst = Instrument::new(SR, Model::Wavetable);
        for (id, value) in [(OSC + WT_TABLE, table as f32), (OSC + OSC_SHAPE, position), (FILTER_TYPE, 0.0), (AMP_SUSTAIN, 1.0)] {
            assert!(inst.set_param(0, id, value));
        }
        inst
    }

    fn play(inst: &mut Instrument, hz: f32, frames: usize) -> Vec<f32> {
        inst.note_on(0, 0, hz, 1.0, frames as i64 * 2);
        let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
        inst.render(0, &mut l, &mut r);
        l
    }

    fn rms(buf: &[f32]) -> f32 {
        libm::sqrtf(buf.iter().map(|s| s * s).sum::<f32>() / buf.len() as f32)
    }

    fn brightness(buf: &[f32]) -> f32 {
        let diff: Vec<f32> = buf.windows(2).map(|w| w[1] - w[0]).collect();
        rms(&diff) / rms(buf)
    }

    fn estimate_hz(buf: &[f32]) -> f32 {
        let crossings: Vec<f32> =
            (1..buf.len()).filter(|&i| buf[i - 1] < 0.0 && buf[i] >= 0.0).map(|i| i as f32 - buf[i] / (buf[i] - buf[i - 1])).collect();
        SR * (crossings.len() - 1) as f32 / (crossings[crossings.len() - 1] - crossings[0])
    }

    #[test]
    fn layout_fits() {
        assert_eq!(level_len(0), FRAME_SIZE);
        assert_eq!(level_len(LEVELS - 1), 64);
        for k in 0..LEVELS {
            assert!(level_harmonics(k) < level_len(k) / 2, "level {k} is band-limited within its length");
        }
        assert_eq!(level_for(20.0, SR), 0);
        assert_eq!(level_for(24_000.0 / 512.0, SR), 0);
        assert_eq!(level_for(24_000.0 / 511.0, SR), 1);
        assert_eq!(level_for(10_000.0, SR), 8);
        assert_eq!(level_for(20_000.0, SR), LEVELS - 1);
    }

    #[test]
    fn position_zero_of_basic_is_a_sine_at_pitch() {
        let mut inst = instrument(0, 0.0);
        let out = play(&mut inst, 440.0, 24_000);
        let hz = estimate_hz(&out[4_800..]);
        assert!((hz - 440.0).abs() < 0.2, "{hz}");
        // A sine's first difference is ω times its level.
        let expected = 2.0 * libm::sinf(core::f32::consts::PI * 440.0 / SR);
        assert!((brightness(&out[4_800..]) - expected).abs() < expected * 0.05);
    }

    #[test]
    fn moving_the_position_changes_the_timbre() {
        for table in 0..TABLE_COUNT {
            let start = brightness(&play(&mut instrument(table, 0.0), 220.0, 24_000)[4_800..]);
            let end = brightness(&play(&mut instrument(table, 1.0), 220.0, 24_000)[4_800..]);
            assert!((end - start).abs() > start * 0.2, "table {table}: {start} -> {end}");
        }
    }

    #[test]
    fn high_notes_stay_band_limited() {
        // Bin 250 of a 4096-point transform: aliases of the square's upper harmonics would land between the
        // harmonics' bins, which are multiples of 250.
        let hz = SR * 250.0 / 4_096.0;
        let mut inst = instrument(0, 1.0);
        let out = play(&mut inst, hz, 32_768);
        let x = &out[24_000..24_000 + 4_096];
        let fft = Fft::new(4_096);
        let (mut re, mut im) = (vec![0.0; 2_049], vec![0.0; 2_049]);
        let (mut wr, mut wi) = (vec![0.0; 2_048], vec![0.0; 2_048]);
        fft.real_forward(x, &mut re, &mut im, &mut wr, &mut wi);
        let (mut harmonic, mut other) = (0.0f64, 0.0f64);
        for k in 1..=2_048 {
            let e = (re[k] * re[k] + im[k] * im[k]) as f64;
            if k % 250 == 0 { harmonic += e } else { other += e }
        }
        assert!(other / harmonic < 1e-3, "{}", other / harmonic);
        assert!(harmonic > 0.0);
    }

    #[test]
    fn every_frame_is_bounded_and_dc_free() {
        let mut bank = WavetableBank::new(true);
        for table in 0..TABLE_COUNT {
            bank.select(0, table);
            for frame in 0..FRAMES {
                for k in 0..LEVELS {
                    let level = bank.level(0, frame, k);
                    let len = level.len() - 1;
                    let body = &level[..len];
                    assert!(body.iter().all(|x| x.is_finite()));
                    let peak = body.iter().fold(0.0f32, |m, x| m.max(x.abs()));
                    let mean = body.iter().sum::<f32>() / len as f32;
                    assert!(peak <= 1.5, "table {table} frame {frame} level {k}: peak {peak}");
                    if k == 0 {
                        assert!((peak - 1.0).abs() < 1e-4, "normalized: {peak}");
                    }
                    assert!(mean.abs() < 1e-3, "table {table} frame {frame} level {k}: dc {mean}");
                    assert_eq!(level[len], level[0], "guard sample");
                }
            }
        }
    }

    #[test]
    fn select_regenerates_in_place() {
        let mut bank = WavetableBank::new(true);
        bank.select(1, 0);
        let pointer = bank.data[1].as_ptr();
        let basic: Vec<f32> = bank.data[1].clone();
        bank.select(1, 0);
        assert_eq!(bank.data[1], basic, "the same table again is a no-op");
        bank.select(1, 5);
        assert_eq!(bank.table(1), Some(5));
        assert_ne!(bank.data[1], basic);
        bank.select(1, 99);
        assert_eq!(bank.table(1), Some(TABLE_COUNT - 1), "clamped to the last table");
        assert_eq!(bank.data[1].as_ptr(), pointer, "no new memory");
        assert_eq!(bank.data[1].len(), SLOT_LEN);

        let mut off = WavetableBank::new(false);
        off.select(0, 3);
        assert_eq!(off.table(0), None);
        assert_eq!(off.data[0].capacity(), 0);
    }

    #[test]
    fn switching_tables_changes_the_sound() {
        let mut inst = instrument(0, 0.5);
        let before = play(&mut inst, 220.0, 9_600);
        let mut inst = instrument(0, 0.5);
        assert!(inst.set_param(0, OSC + WT_TABLE, 3.0));
        let after = play(&mut inst, 220.0, 9_600);
        assert!((brightness(&before[4_800..]) - brightness(&after[4_800..])).abs() > 0.01);
    }

    #[test]
    fn every_table_plays_finite_and_centred_in_unison() {
        for table in 0..TABLE_COUNT {
            for position in [0.0, 0.37, 1.0] {
                let mut inst = instrument(table, position);
                for (id, value) in [(UNISON, 7.0), (UNISON_SPREAD, 1.0), (OSC + OSC_STRIDE + OSC_LEVEL, 1.0), (OSC + OSC_STRIDE + WT_TABLE, ((table + 3) % TABLE_COUNT) as f32)] {
                    inst.set_param(0, id, value);
                }
                inst.note_on(0, 0, 55.0, 1.0, 96_000);
                let (mut l, mut r) = (vec![0.0; 48_000], vec![0.0; 48_000]);
                inst.render(0, &mut l, &mut r);
                assert!(l.iter().chain(&r).all(|s| s.is_finite() && s.abs() < 8.0), "table {table} position {position}");
                let mean = l[9_600..].iter().sum::<f32>() / (l.len() - 9_600) as f32;
                assert!(mean.abs() < 0.02, "table {table} position {position}: dc {mean}");
                assert_ne!(l, r, "spread is stereo");
            }
        }
    }

    #[test]
    fn regeneration_cost() {
        let mut bank = WavetableBank::new(true);
        let start = std::time::Instant::now();
        for table in 0..TABLE_COUNT {
            bank.select(0, table);
        }
        let per_table = start.elapsed() / TABLE_COUNT;
        std::println!("wavetable regeneration: {per_table:?} per table (native); slot {} KiB", SLOT_LEN * 4 / 1024);
    }
}
