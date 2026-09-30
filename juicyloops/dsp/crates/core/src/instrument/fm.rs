//! The FM model's generator: four sine operators in one of the eight classic 4-operator algorithms (the TX81Z /
//! DX9 set), with self-feedback on operator 4.
//!
//! It is phase modulation, as on the DX synths: a modulator's output is added to the phase (in turns) of the
//! operators it feeds. A modulator's index is `level² · MAX_INDEX` turns (level 1 ≈ 3π radians of peak phase
//! deviation, bright but not noise); the square gives the level knob an even feel across its range. Carriers are
//! summed and divided by how many there are, so switching algorithms keeps the loudness about the same.
//!
//! Every operator has its own envelope (it multiplies the operator's output) and velocity sensitivity. The voice's
//! amp envelope still ends the note; the operator envelopes only shape it.
//!
//! Modulation (see `Dest`): pitch A shifts every modulator, pitch B operator 4, shape A scales the modulators'
//! index by 2^(2·amount) (±2 octaves of brightness), shape B adds to the feedback, level B scales the carriers by
//! (1 + amount).

use super::params::*;
use super::voice::{Shared, SourceControl};
use crate::math::{note_to_hz, semitones_ratio, sin_turns};
use crate::{Adsr, AdsrParams};

/// Peak phase deviation of a modulator at level 1, in turns.
const MAX_INDEX: f32 = 1.5;
/// Largest index a modulated modulator may reach (shape A can push past level 1).
const MAX_MOD_INDEX: f32 = 4.0 * MAX_INDEX;
/// Peak phase deviation of operator 4's feedback at full feedback, in turns (≈ a saw-like spectrum).
const MAX_FEEDBACK: f32 = 0.25;

/// One algorithm: `mods[i]` is the bit set of the operators that modulate operator `i` (bit `j` = operator j + 1),
/// `carriers` the operators that are heard. A modulator always has a higher index than what it modulates, so the
/// operators are computed from 4 down to 1.
#[derive(Clone, Copy, Debug)]
struct Algorithm {
    mods: [u8; 4],
    carriers: u8,
}

const fn op(n: u8) -> u8 {
    1 << (n - 1)
}

/// The eight algorithms, numbered as on the TX81Z (1..=8 there, 0..=7 here). Operator 4 has the feedback in all.
const ALGORITHMS: [Algorithm; 8] = [
    // 1: 4 → 3 → 2 → 1
    Algorithm { mods: [op(2), op(3), op(4), 0], carriers: op(1) },
    // 2: (3 + 4) → 2 → 1
    Algorithm { mods: [op(2), op(3) | op(4), 0, 0], carriers: op(1) },
    // 3: 3 → 2 → 1, 4 → 1
    Algorithm { mods: [op(2) | op(4), op(3), 0, 0], carriers: op(1) },
    // 4: 4 → 3 → 1, 2 → 1
    Algorithm { mods: [op(2) | op(3), 0, op(4), 0], carriers: op(1) },
    // 5: 2 → 1, 4 → 3; carriers 1, 3
    Algorithm { mods: [op(2), 0, op(4), 0], carriers: op(1) | op(3) },
    // 6: 4 → 1, 4 → 2, 4 → 3; carriers 1, 2, 3
    Algorithm { mods: [op(4), op(4), op(4), 0], carriers: op(1) | op(2) | op(3) },
    // 7: 4 → 3; carriers 1, 2, 3
    Algorithm { mods: [0, 0, op(4), 0], carriers: op(1) | op(2) | op(3) },
    // 8: every operator a carrier (additive)
    Algorithm { mods: [0, 0, 0, 0], carriers: op(1) | op(2) | op(3) | op(4) },
];

fn op_env_params(patch: &Patch, n: u32) -> AdsrParams {
    AdsrParams {
        attack_s: patch.op(n, OP_ATTACK).max(0.0),
        decay_s: patch.op(n, OP_DECAY).max(0.0),
        sustain: patch.op(n, OP_SUSTAIN),
        release_s: patch.op(n, OP_RELEASE).max(0.0),
    }
}

#[derive(Clone, Debug)]
pub struct FmSource {
    /// Operator phases in turns, 0..1.
    phases: [f32; 4],
    envs: [Adsr; 4],
    /// The sample rate the envelopes were built for (the voice builds this source before it knows it).
    sample_rate: f32,
    /// Each operator's velocity scale for the current note.
    velocity: [f32; 4],
    /// Operator gains (carrier level or modulator index) at the end of the last block, where the next glides from.
    gains: [f32; 4],
    /// Operator 4's last two outputs, for feedback.
    feedback: [f32; 2],
}

impl Default for FmSource {
    fn default() -> Self {
        Self::new()
    }
}

impl FmSource {
    pub fn new() -> Self {
        let sample_rate = 48_000.0;
        Self {
            phases: [0.0; 4],
            envs: core::array::from_fn(|_| Adsr::new(sample_rate, AdsrParams::default())),
            sample_rate,
            velocity: [1.0; 4],
            gains: [0.0; 4],
            feedback: [0.0; 2],
        }
    }

    pub fn start(&mut self, shared: &Shared, fresh: bool, velocity: f32) {
        let patch = shared.patch;
        if shared.sample_rate != self.sample_rate {
            self.sample_rate = shared.sample_rate;
            self.envs = core::array::from_fn(|n| Adsr::new(shared.sample_rate, op_env_params(patch, n as u32)));
        } else {
            self.update(shared);
        }
        for n in 0..4 {
            let sensitivity = patch.op(n as u32, OP_VELOCITY).clamp(0.0, 1.0);
            self.velocity[n] = 1.0 - sensitivity + sensitivity * velocity;
        }
        if fresh {
            self.phases = [0.0; 4];
            self.gains = [0.0; 4];
            self.feedback = [0.0; 2];
            for env in &mut self.envs {
                env.reset();
            }
        }
        for env in &mut self.envs {
            env.gate_on();
        }
    }

    pub fn release(&mut self) {
        for env in &mut self.envs {
            env.gate_off();
        }
    }

    /// Pushes the patch's operator envelope settings to the envelopes.
    pub fn update(&mut self, shared: &Shared) {
        for (n, env) in self.envs.iter_mut().enumerate() {
            env.set_params(op_env_params(shared.patch, n as u32));
        }
    }

    pub fn render(&mut self, shared: &Shared, control: &SourceControl, left: &mut [f32], _right: &mut [f32]) -> bool {
        let patch = shared.patch;
        let sr = shared.sample_rate;
        let algorithm = ALGORITHMS[(patch.get(FM_ALGORITHM).max(0.0) as usize).min(ALGORITHMS.len() - 1)];
        let carriers = algorithm.carriers.count_ones().max(1) as f32;
        let base_hz = note_to_hz(control.note);
        let brightness = libm::exp2f(2.0 * control.shape_a);
        let carrier_scale = (1.0 + control.level_b).max(0.0) / carriers;

        let mut dt = [0.0f32; 4];
        let mut target = [0.0f32; 4];
        for n in 0..4 {
            let is_carrier = algorithm.carriers & (1 << n) != 0;
            let mut semitones = patch.op(n as u32, OP_DETUNE) / 100.0;
            if !is_carrier {
                semitones += control.pitch_a;
            }
            if n == 3 {
                semitones += control.pitch_b;
            }
            let ratio = patch.op(n as u32, OP_RATIO).clamp(0.0, 32.0);
            dt[n] = (base_hz * ratio * semitones_ratio(semitones) / sr).clamp(0.0, 0.5);
            let level = patch.op(n as u32, OP_LEVEL).clamp(0.0, 1.0) * self.velocity[n];
            target[n] = if is_carrier {
                level * carrier_scale
            } else {
                (level * level * MAX_INDEX * brightness).min(MAX_MOD_INDEX)
            };
        }
        let feedback = (patch.get(FM_FEEDBACK) + control.shape_b).clamp(0.0, 1.0) * MAX_FEEDBACK * 0.5;

        let step = 1.0 / left.len().max(1) as f32;
        let delta: [f32; 4] = core::array::from_fn(|n| (target[n] - self.gains[n]) * step);
        let mut gains = self.gains;
        let [m0, m1, m2, _] = algorithm.mods;
        let carrier_bits = algorithm.carriers;
        for sample in left.iter_mut() {
            for n in 0..4 {
                gains[n] += delta[n];
            }
            // Operator 4: feedback only.
            let e3 = self.envs[3].next_sample();
            let s3 = sin_turns(self.phases[3] + feedback * (self.feedback[0] + self.feedback[1])) * e3;
            self.feedback[1] = self.feedback[0];
            self.feedback[0] = s3;
            let o3 = s3 * gains[3];
            // Operators 3, 2, 1: modulated by the higher ones their mask names.
            let e2 = self.envs[2].next_sample();
            let pm2 = if m2 & op(4) != 0 { o3 } else { 0.0 };
            let o2 = sin_turns(self.phases[2] + pm2) * e2 * gains[2];
            let e1 = self.envs[1].next_sample();
            let pm1 = pick(m1, op(3), o2) + pick(m1, op(4), o3);
            let o1 = sin_turns(self.phases[1] + pm1) * e1 * gains[1];
            let e0 = self.envs[0].next_sample();
            let pm0 = pick(m0, op(2), o1) + pick(m0, op(3), o2) + pick(m0, op(4), o3);
            let o0 = sin_turns(self.phases[0] + pm0) * e0 * gains[0];

            *sample = o0 + pick(carrier_bits, op(2), o1) + pick(carrier_bits, op(3), o2) + pick(carrier_bits, op(4), o3);

            for n in 0..4 {
                let t = self.phases[n] + dt[n];
                self.phases[n] = if t >= 1.0 { t - 1.0 } else { t };
            }
        }
        self.gains = target;
        false
    }
}

/// `value` when `bit` is in `mask`, else 0.
#[inline]
fn pick(mask: u8, bit: u8, value: f32) -> f32 {
    if mask & bit != 0 { value } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instrument::{Instrument, Model};
    use alloc::vec;
    use alloc::vec::Vec;

    const SR: f32 = 48_000.0;

    fn rms(buf: &[f32]) -> f32 {
        libm::sqrtf(buf.iter().map(|s| s * s).sum::<f32>() / buf.len() as f32)
    }

    /// Brightness: the level of the first difference relative to the level.
    fn rough(buf: &[f32]) -> f32 {
        let diff: Vec<f32> = buf.windows(2).map(|w| w[1] - w[0]).collect();
        rms(&diff) / rms(buf)
    }

    fn estimate_hz(buf: &[f32]) -> f32 {
        let crossings: Vec<f32> = (1..buf.len())
            .filter(|&i| buf[i - 1] < 0.0 && buf[i] >= 0.0)
            .map(|i| i as f32 - buf[i] / (buf[i] - buf[i - 1]))
            .collect();
        SR * (crossings.len() - 1) as f32 / (crossings[crossings.len() - 1] - crossings[0])
    }

    fn fm(settings: &[(u32, f32)]) -> Instrument {
        let mut inst = Instrument::new(SR, Model::Fm);
        for &(id, value) in settings {
            assert!(inst.set_param(0, id, value));
        }
        inst
    }

    fn op_param(n: u32, field: u32) -> u32 {
        OP + n * OP_STRIDE + field
    }

    fn play(inst: &mut Instrument, hz: f32, velocity: f32) -> Vec<f32> {
        inst.note_on(0, 0, hz, velocity, 48_000);
        let mut l = vec![0.0; 24_000];
        let mut r = vec![0.0; 24_000];
        inst.render(0, &mut l, &mut r);
        l
    }

    /// Sustained operators, so the tone is steady after the attack.
    fn steady() -> Vec<(u32, f32)> {
        let mut settings = vec![(AMP_SUSTAIN, 1.0)];
        for n in 0..4 {
            settings.push((op_param(n, OP_SUSTAIN), 1.0));
            settings.push((op_param(n, OP_VELOCITY), 0.0));
        }
        settings
    }

    #[test]
    fn a_lone_carrier_is_a_sine_at_the_note() {
        let mut settings = steady();
        settings.push((op_param(1, OP_LEVEL), 0.0));
        let out = play(&mut fm(&settings), 440.0, 1.0);
        let body = &out[4_000..];
        assert!((estimate_hz(body) - 440.0).abs() < 0.2, "{}", estimate_hz(body));
        // A sine's brightness is 2π·f/sr.
        let sine = 2.0 * core::f32::consts::PI * 440.0 / SR;
        assert!((rough(body) - sine).abs() < sine * 0.05, "{} vs {sine}", rough(body));
    }

    #[test]
    fn a_louder_modulator_is_brighter_and_keeps_the_pitch() {
        let brightness = |level: f32| {
            let mut settings = steady();
            settings.push((op_param(1, OP_LEVEL), level));
            settings.push((op_param(1, OP_RATIO), 2.0));
            // 240 Hz: a whole number of frames per period (200), so the waveform repeats exactly.
            let out = play(&mut fm(&settings), 240.0, 1.0);
            (rough(&out[4_000..]), out)
        };
        let (soft, _) = brightness(0.2);
        let (hard, out) = brightness(0.8);
        assert!(hard > soft * 1.5, "{soft} -> {hard}");
        // Ratio 2 keeps the spectrum harmonic: the period is still the note's. Upward zero crossings may come several
        // per period, so compare the waveform with itself one period later.
        let shift = 2_000;
        let body = &out[4_000..20_000];
        let diff: Vec<f32> = body[..body.len() - shift].iter().zip(&body[shift..]).map(|(a, b)| a - b).collect();
        assert!(rms(&diff) < rms(body) * 0.01, "{} vs {}", rms(&diff), rms(body));
    }

    #[test]
    fn full_feedback_stays_bounded() {
        let mut settings = steady();
        settings.extend([(FM_ALGORITHM, 7.0), (FM_FEEDBACK, 1.0), (op_param(3, OP_LEVEL), 1.0)]);
        let out = play(&mut fm(&settings), 110.0, 1.0);
        assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.01));
        assert!(rms(&out[4_000..]) > 0.05);
    }

    #[test]
    fn every_algorithm_sounds_and_stays_finite() {
        for algorithm in 0..8 {
            let mut settings = steady();
            settings.push((FM_ALGORITHM, algorithm as f32));
            settings.push((FM_FEEDBACK, 0.7));
            for n in 0..4 {
                settings.push((op_param(n, OP_LEVEL), 0.8));
                settings.push((op_param(n, OP_RATIO), (n + 1) as f32));
            }
            let out = play(&mut fm(&settings), 220.0, 1.0);
            assert!(out.iter().all(|s| s.is_finite() && s.abs() < 2.0), "algorithm {algorithm}");
            assert!(rms(&out[4_000..]) > 0.05, "algorithm {algorithm} is silent");
        }
    }

    #[test]
    fn modulator_velocity_sets_the_brightness() {
        let mut settings = steady();
        settings.push((op_param(1, OP_VELOCITY), 1.0));
        let soft = rough(&play(&mut fm(&settings), 220.0, 0.3)[4_000..]);
        let hard = rough(&play(&mut fm(&settings), 220.0, 1.0)[4_000..]);
        assert!(hard > soft * 1.3, "{soft} -> {hard}");
    }

    #[test]
    fn operator_envelopes_shape_the_tone() {
        // The modulator decays to nothing: the note starts bright and ends a pure sine.
        let mut settings = steady();
        settings.extend([(op_param(1, OP_SUSTAIN), 0.0), (op_param(1, OP_DECAY), 0.1)]);
        let out = play(&mut fm(&settings), 220.0, 1.0);
        assert!(rough(&out[200..1_500]) > rough(&out[20_000..]) * 1.5);
    }
}
