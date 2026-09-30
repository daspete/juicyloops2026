//! The analog model's generator: three band-limited oscillators (sine, triangle, saw, pulse with width), a sub
//! oscillator an octave under oscillator 1, and white noise. Every oscillator can run as up to `MAX_UNISON`
//! detuned copies spread across the stereo field.

use super::params::*;
use super::voice::{Shared, SourceControl, MAX_UNISON};
use crate::math::{note_to_hz, semitones_ratio, sin_turns, Rng};

#[inline]
fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

#[inline]
fn poly_blamp(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt - 1.0;
        -(x * x * x) / 3.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt + 1.0;
        (x * x * x) / 3.0
    } else {
        0.0
    }
}

#[inline]
fn wrap(t: f32) -> f32 {
    if t >= 1.0 { t - 1.0 } else { t }
}

/// One sample of a band-limited wave at phase `t` (0..1) with phase step `dt`. `wave`: 0 sine, 1 triangle,
/// 2 saw, 3 pulse of width `pw`. The pulse is centred, so its level does not jump with the width.
#[inline]
pub fn wave_sample(wave: u32, t: f32, dt: f32, pw: f32) -> f32 {
    match wave {
        1 => {
            let naive = if t < 0.25 {
                4.0 * t
            } else if t < 0.75 {
                2.0 - 4.0 * t
            } else {
                4.0 * t - 4.0
            };
            naive + 8.0 * dt * (poly_blamp(wrap(t + 0.25), dt) - poly_blamp(wrap(t + 0.75), dt))
        }
        2 => (2.0 * t - 1.0) - poly_blep(t, dt),
        3 => {
            let naive = if t < pw { 1.0 } else { -1.0 };
            naive + poly_blep(t, dt) - poly_blep(wrap(t + 1.0 - pw), dt) - (2.0 * pw - 1.0)
        }
        _ => sin_turns(t),
    }
}

/// Level per unison copy count, so stacking copies keeps the loudness about the same.
pub fn unison_gain(count: usize) -> f32 {
    1.0 / libm::sqrtf(count as f32)
}

/// Detune (semitones) and pan (-1..=1) of unison copy `i` of `count`.
#[inline]
pub fn unison_spread(i: usize, count: usize, detune: f32, spread: f32) -> (f32, f32) {
    if count <= 1 {
        return (0.0, 0.0);
    }
    let x = i as f32 / (count - 1) as f32 * 2.0 - 1.0;
    (x * detune * 0.5, x * spread)
}

#[derive(Clone, Debug)]
pub struct AnalogSource {
    phases: [[f32; MAX_UNISON]; 3],
    sub: f32,
    rng: Rng,
}

impl AnalogSource {
    pub fn new(seed: u32) -> Self {
        Self { phases: [[0.0; MAX_UNISON]; 3], sub: 0.0, rng: Rng::new(seed) }
    }

    pub fn start(&mut self, shared: &Shared, fresh: bool) {
        if !fresh {
            return;
        }
        // One copy starts on phase 0 (a punchy, repeatable attack); stacked copies start anywhere, like free-running
        // analog oscillators, so they do not all line up and flam.
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
        for osc in 0..3u32 {
            let note = control.note
                + 12.0 * patch.osc(osc, OSC_OCTAVE)
                + patch.osc(osc, OSC_SEMI)
                + patch.osc(osc, OSC_FINE) / 100.0
                + match osc {
                    0 => control.pitch_a,
                    1 => control.pitch_b,
                    _ => 0.0,
                };
            let hz = note_to_hz(note);
            if osc == 0 {
                osc1_hz = hz;
            }
            let level = (patch.osc(osc, OSC_LEVEL) + if osc == 1 { control.level_b } else { 0.0 }).clamp(0.0, 1.0);
            if level <= 0.0 {
                continue;
            }
            let wave = patch.osc(osc, OSC_WAVE) as u32;
            let shape_mod = match osc {
                0 => control.shape_a,
                1 => control.shape_b,
                _ => 0.0,
            };
            let pw = (patch.osc(osc, OSC_SHAPE) + shape_mod * 0.45).clamp(0.05, 0.95);
            let gain = level * copy_gain;
            for copy in 0..count {
                let (cents, pan) = unison_spread(copy, count, detune, spread);
                let dt = (hz * semitones_ratio(cents) / sr).clamp(0.0, 0.49);
                let mut t = self.phases[osc as usize][copy];
                if stereo {
                    let gl = gain * (1.0 - pan).min(1.0);
                    let gr = gain * (1.0 + pan).min(1.0);
                    for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                        let s = wave_sample(wave, t, dt, pw);
                        *l += s * gl;
                        *r += s * gr;
                        t = wrap(t + dt);
                    }
                } else {
                    for l in left.iter_mut() {
                        *l += wave_sample(wave, t, dt, pw) * gain;
                        t = wrap(t + dt);
                    }
                }
                self.phases[osc as usize][copy] = t;
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
                    self.sub = wrap(self.sub + dt);
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
    use super::*;

    #[test]
    fn waves_are_bounded_and_centred() {
        for wave in 0..4 {
            for pw in [0.1, 0.5, 0.9] {
                let dt = 440.0 / 48_000.0;
                let (mut t, mut sum, mut peak) = (0.0f32, 0.0f32, 0.0f32);
                let n = 48_000;
                for _ in 0..n {
                    let s = wave_sample(wave, t, dt, pw);
                    sum += s;
                    peak = peak.max(s.abs());
                    t = wrap(t + dt);
                }
                assert!(peak < 2.0, "wave {wave} pw {pw} peak {peak}");
                assert!((sum / n as f32).abs() < 0.02, "wave {wave} pw {pw} dc {}", sum / n as f32);
            }
        }
    }

    #[test]
    fn unison_copies_spread_symmetrically() {
        assert_eq!(unison_spread(0, 1, 1.0, 1.0), (0.0, 0.0));
        let (d0, p0) = unison_spread(0, 3, 1.0, 1.0);
        let (d1, p1) = unison_spread(1, 3, 1.0, 1.0);
        let (d2, p2) = unison_spread(2, 3, 1.0, 1.0);
        assert_eq!((d0, p0), (-0.5, -1.0));
        assert_eq!((d1, p1), (0.0, 0.0));
        assert_eq!((d2, p2), (0.5, 1.0));
    }
}
