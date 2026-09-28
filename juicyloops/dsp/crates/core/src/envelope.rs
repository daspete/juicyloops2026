//! ADSR envelope: linear attack, exponential decay and release.
//!
//! The exponential segments approach a target slightly beyond the goal (`OVERSHOOT`) so they end in finite
//! time, which keeps the stage timings predictable (the classic analog-style "target ratio" trick).

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AdsrParams {
    pub attack_s: f32,
    pub decay_s: f32,
    /// 0..=1
    pub sustain: f32,
    pub release_s: f32,
}

impl Default for AdsrParams {
    fn default() -> Self {
        // Tone.js Synth defaults.
        Self { attack_s: 0.005, decay_s: 0.1, sustain: 0.3, release_s: 1.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// How far past the goal the exponential segments aim, relative to the segment height.
const OVERSHOOT: f32 = 0.001;
/// Level below which the release is considered finished.
const SILENCE: f32 = 1.0e-5;

#[derive(Clone, Debug)]
pub struct Adsr {
    params: AdsrParams,
    sample_rate: f32,
    stage: Stage,
    value: f32,
    attack_step: f32,
    decay_coeff: f32,
    decay_base: f32,
    release_coeff: f32,
    release_base: f32,
}

/// Coefficient for an exponential segment that covers the distance to `goal` in `time_s`,
/// aiming at `goal - OVERSHOOT * height`.
fn exp_coeff(sample_rate: f32, time_s: f32) -> f32 {
    let samples = (time_s * sample_rate).max(1.0);
    libm::expf(-libm::logf((1.0 + OVERSHOOT) / OVERSHOOT) / samples)
}

impl Adsr {
    pub fn new(sample_rate: f32, params: AdsrParams) -> Self {
        let mut env = Self {
            params,
            sample_rate,
            stage: Stage::Idle,
            value: 0.0,
            attack_step: 0.0,
            decay_coeff: 0.0,
            decay_base: 0.0,
            release_coeff: 0.0,
            release_base: 0.0,
        };
        env.set_params(params);
        env
    }

    pub fn set_params(&mut self, params: AdsrParams) {
        self.params = AdsrParams { sustain: params.sustain.clamp(0.0, 1.0), ..params };
        let sr = self.sample_rate;
        self.attack_step = 1.0 / (self.params.attack_s * sr).max(1.0);
        self.decay_coeff = exp_coeff(sr, self.params.decay_s);
        let sustain = self.params.sustain;
        self.decay_base = (sustain - OVERSHOOT * (1.0 - sustain)) * (1.0 - self.decay_coeff);
        self.release_coeff = exp_coeff(sr, self.params.release_s);
        // Release always spans the full height (1 -> 0) so its duration does not depend on the level.
        self.release_base = -OVERSHOOT * (1.0 - self.release_coeff);
    }

    /// Changes only the sustain level: cheap enough to call on every sample while the level glides.
    #[inline]
    pub fn set_sustain(&mut self, sustain: f32) {
        let sustain = sustain.clamp(0.0, 1.0);
        self.params.sustain = sustain;
        self.decay_base = (sustain - OVERSHOOT * (1.0 - sustain)) * (1.0 - self.decay_coeff);
    }

    pub fn params(&self) -> AdsrParams {
        self.params
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    pub fn value(&self) -> f32 {
        self.value
    }

    pub fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    /// Starts the attack from the current level (legato retrigger does not click).
    pub fn gate_on(&mut self) {
        self.stage = Stage::Attack;
    }

    pub fn gate_off(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }

    pub fn reset(&mut self) {
        self.stage = Stage::Idle;
        self.value = 0.0;
    }

    #[inline]
    pub fn next_sample(&mut self) -> f32 {
        match self.stage {
            Stage::Idle => {}
            Stage::Attack => {
                self.value += self.attack_step;
                if self.value >= 1.0 {
                    self.value = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.value = self.decay_base + self.value * self.decay_coeff;
                if self.value <= self.params.sustain {
                    self.value = self.params.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => self.value = self.params.sustain,
            Stage::Release => {
                self.value = self.release_base + self.value * self.release_coeff;
                if self.value <= SILENCE {
                    self.value = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn run_until(env: &mut Adsr, stage_not: Stage, limit: usize) -> usize {
        let mut n = 0;
        while env.stage() == stage_not && n < limit {
            env.next_sample();
            n += 1;
        }
        n
    }

    #[test]
    fn attack_takes_attack_time() {
        let mut env = Adsr::new(SR, AdsrParams { attack_s: 0.01, decay_s: 0.1, sustain: 0.5, release_s: 0.2 });
        env.gate_on();
        let n = run_until(&mut env, Stage::Attack, 100_000);
        assert_eq!(n, 480);
        assert_eq!(env.value(), 1.0);
    }

    #[test]
    fn decay_reaches_sustain_in_decay_time() {
        let mut env = Adsr::new(SR, AdsrParams { attack_s: 0.001, decay_s: 0.1, sustain: 0.5, release_s: 0.2 });
        env.gate_on();
        run_until(&mut env, Stage::Attack, 100_000);
        let n = run_until(&mut env, Stage::Decay, 100_000) as f32;
        assert!((n - 4_800.0).abs() < 48.0, "decay took {n} samples");
        assert_eq!(env.stage(), Stage::Sustain);
        assert_eq!(env.next_sample(), 0.5);
    }

    #[test]
    fn decay_is_exponential() {
        // Halfway through the decay the level is well below the linear midpoint.
        let mut env = Adsr::new(SR, AdsrParams { attack_s: 0.001, decay_s: 0.1, sustain: 0.0, release_s: 0.2 });
        env.gate_on();
        run_until(&mut env, Stage::Attack, 100_000);
        for _ in 0..2_400 {
            env.next_sample();
        }
        assert!(env.value() < 0.1, "{}", env.value());
    }

    #[test]
    fn release_goes_idle_in_release_time() {
        let mut env = Adsr::new(SR, AdsrParams { attack_s: 0.001, decay_s: 0.01, sustain: 1.0, release_s: 0.2 });
        env.gate_on();
        for _ in 0..1_000 {
            env.next_sample();
        }
        env.gate_off();
        let n = run_until(&mut env, Stage::Release, 1_000_000) as f32;
        assert!(env.is_idle());
        assert!(n <= 9_600.0 && n > 9_600.0 * 0.8, "release took {n} samples");
        assert_eq!(env.next_sample(), 0.0);
    }

    #[test]
    fn retrigger_continues_from_current_level() {
        let mut env = Adsr::new(SR, AdsrParams { attack_s: 0.01, decay_s: 0.01, sustain: 0.5, release_s: 1.0 });
        env.gate_on();
        for _ in 0..2_000 {
            env.next_sample();
        }
        env.gate_off();
        for _ in 0..100 {
            env.next_sample();
        }
        let before = env.value();
        env.gate_on();
        let after = env.next_sample();
        assert!(after > before && after - before < 0.01, "{before} -> {after}");
    }
}
