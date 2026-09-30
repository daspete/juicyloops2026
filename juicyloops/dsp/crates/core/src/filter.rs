//! Voice filters, both zero-delay-feedback (topology-preserving transform) designs so cutoff and resonance can
//! move every sample without blowing up:
//!
//! - a state-variable filter for the 12 dB modes (low-, band-, high-pass, notch);
//! - a 4-pole ladder for the 24 dB low-pass, with a gentle saturator inside the feedback loop so it can
//!   self-oscillate without running away.
//!
//! Both take an optional drive: a soft clipper in front, with make-up gain so turning it up adds grit, not level.

use crate::math::soft_clip;
use core::f32::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FilterMode {
    Off = 0,
    LowPass24 = 1,
    LowPass12 = 2,
    BandPass12 = 3,
    HighPass12 = 4,
    Notch = 5,
}

impl FilterMode {
    pub fn from_u32(value: u32) -> Self {
        match value {
            1 => FilterMode::LowPass24,
            2 => FilterMode::LowPass12,
            3 => FilterMode::BandPass12,
            4 => FilterMode::HighPass12,
            5 => FilterMode::Notch,
            _ => FilterMode::Off,
        }
    }
}

/// Highest cutoff as a fraction of the sample rate; `tan` goes to infinity at 0.5.
const MAX_CUTOFF_RATIO: f32 = 0.45;
/// Lowest cutoff in Hz.
pub const MIN_CUTOFF_HZ: f32 = 16.0;

/// The prewarped integrator gain for a cutoff, clamped to what the filters can take.
#[inline]
pub fn cutoff_gain(cutoff_hz: f32, sample_rate: f32) -> f32 {
    let hz = cutoff_hz.clamp(MIN_CUTOFF_HZ, MAX_CUTOFF_RATIO * sample_rate);
    libm::tanf(PI * hz / sample_rate)
}

#[derive(Clone, Debug)]
pub struct Filter {
    pub mode: FilterMode,
    /// SVF: the two integrator states. Ladder: the four one-pole states.
    s: [f32; 4],
    /// Coefficients reached at the end of the last block, where the next one starts gliding from.
    g: f32,
    res: f32,
}

impl Default for Filter {
    fn default() -> Self {
        Self::new()
    }
}

impl Filter {
    pub fn new() -> Self {
        Self { mode: FilterMode::Off, s: [0.0; 4], g: 0.0, res: 0.0 }
    }

    /// Clears the states and jumps the coefficients (a fresh voice).
    pub fn reset(&mut self, g: f32, res: f32) {
        self.s = [0.0; 4];
        self.g = g;
        self.res = res;
    }

    pub fn set_mode(&mut self, mode: FilterMode) {
        if mode != self.mode {
            // The states mean different things in each topology.
            self.s = [0.0; 4];
            self.mode = mode;
        }
    }

    /// Filters `buf` in place while gain `g` (see `cutoff_gain`) and resonance (0..=1) glide linearly from where
    /// the last block ended to `g_to` and `res_to`. `drive` is 0..=1.
    pub fn process(&mut self, buf: &mut [f32], g_to: f32, res_to: f32, drive: f32) {
        let n = buf.len();
        if n == 0 {
            return;
        }
        let res_to = res_to.clamp(0.0, 1.0);
        if self.mode == FilterMode::Off {
            self.g = g_to;
            self.res = res_to;
            apply_drive(buf, drive);
            return;
        }
        apply_drive(buf, drive);
        let dg = (g_to - self.g) / n as f32;
        let dr = (res_to - self.res) / n as f32;
        let (mut g, mut res) = (self.g, self.res);
        match self.mode {
            FilterMode::LowPass24 => {
                for x in buf.iter_mut() {
                    g += dg;
                    res += dr;
                    *x = self.ladder(*x, g, res);
                }
            }
            mode => {
                for x in buf.iter_mut() {
                    g += dg;
                    res += dr;
                    let (lp, bp, hp) = self.svf(*x, g, res);
                    *x = match mode {
                        FilterMode::LowPass12 => lp,
                        FilterMode::BandPass12 => bp,
                        FilterMode::HighPass12 => hp,
                        _ => lp + hp,
                    };
                }
            }
        }
        self.g = g_to;
        self.res = res_to;
    }

    /// One sample of the state-variable filter (Simper's form); returns low, band and high pass.
    #[inline]
    fn svf(&mut self, x: f32, g: f32, res: f32) -> (f32, f32, f32) {
        let k = 2.0 - 1.96 * res;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let [ic1, ic2, ..] = self.s;
        let v3 = x - ic2;
        let v1 = a1 * ic1 + a2 * v3;
        let v2 = ic2 + a2 * ic1 + a3 * v3;
        self.s[0] = 2.0 * v1 - ic1;
        self.s[1] = 2.0 * v2 - ic2;
        (v2, v1, x - k * v1 - v2)
    }

    /// One sample of the 4-pole ladder (Zavalishin's linear ZDF solution, saturated at the loop input).
    #[inline]
    fn ladder(&mut self, x: f32, g: f32, res: f32) -> f32 {
        let k = 4.0 * res;
        let big_g = g / (1.0 + g);
        let inv = 1.0 / (1.0 + g);
        let [s0, s1, s2, s3] = self.s;
        let g2 = big_g * big_g;
        let sigma = g2 * big_g * s0 * inv + g2 * s1 * inv + big_g * s2 * inv + s3 * inv;
        // Partly make up the pass-band loss that resonance brings.
        let x = x * (1.0 + 0.5 * k);
        let u = (x - k * sigma) / (1.0 + k * g2 * g2);
        let mut v = 2.0 * soft_clip(0.5 * u);
        for s in &mut self.s {
            let t = (v - *s) * big_g;
            let lp = t + *s;
            *s = lp + t;
            v = lp;
        }
        v
    }
}

#[inline]
fn apply_drive(buf: &mut [f32], drive: f32) {
    if drive <= 0.0 {
        return;
    }
    let gain = 1.0 + 8.0 * drive.min(1.0);
    let makeup = 1.0 / libm::sqrtf(gain);
    for x in buf.iter_mut() {
        *x = soft_clip(*x * gain) * makeup;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::sin_turns;
    use alloc::vec::Vec;

    const SR: f32 = 48_000.0;

    /// Steady-state RMS gain of the filter for a sine at `hz`.
    fn gain_at(mode: FilterMode, cutoff: f32, res: f32, hz: f32) -> f32 {
        let mut filter = Filter::new();
        filter.set_mode(mode);
        let g = cutoff_gain(cutoff, SR);
        filter.reset(g, res);
        let mut buf: Vec<f32> = (0..48_000).map(|i| sin_turns(hz * i as f32 / SR)).collect();
        for block in buf.chunks_mut(16) {
            filter.process(block, g, res, 0.0);
        }
        let tail = &buf[24_000..];
        libm::sqrtf(tail.iter().map(|s| s * s).sum::<f32>() / tail.len() as f32) / core::f32::consts::FRAC_1_SQRT_2
    }

    #[test]
    fn low_pass_passes_lows_and_cuts_highs() {
        for mode in [FilterMode::LowPass12, FilterMode::LowPass24] {
            let low = gain_at(mode, 1_000.0, 0.0, 100.0);
            let high = gain_at(mode, 1_000.0, 0.0, 8_000.0);
            assert!(low > 0.85, "{mode:?} low {low}");
            assert!(high < 0.05, "{mode:?} high {high}");
        }
        // 24 dB cuts harder than 12 dB an octave and a bit above the cutoff.
        assert!(gain_at(FilterMode::LowPass24, 1_000.0, 0.0, 3_000.0) < gain_at(FilterMode::LowPass12, 1_000.0, 0.0, 3_000.0));
    }

    #[test]
    fn high_and_band_pass_shapes() {
        assert!(gain_at(FilterMode::HighPass12, 1_000.0, 0.0, 100.0) < 0.05);
        assert!(gain_at(FilterMode::HighPass12, 1_000.0, 0.0, 8_000.0) > 0.9);
        let centre = gain_at(FilterMode::BandPass12, 1_000.0, 0.5, 1_000.0);
        assert!(centre > gain_at(FilterMode::BandPass12, 1_000.0, 0.5, 100.0) * 4.0);
        assert!(centre > gain_at(FilterMode::BandPass12, 1_000.0, 0.5, 10_000.0) * 4.0);
        assert!(gain_at(FilterMode::Notch, 1_000.0, 0.0, 1_000.0) < 0.05);
    }

    #[test]
    fn resonance_peaks_at_the_cutoff() {
        for mode in [FilterMode::LowPass12, FilterMode::LowPass24] {
            let flat = gain_at(mode, 1_000.0, 0.0, 1_000.0);
            let peaked = gain_at(mode, 1_000.0, 0.9, 1_000.0);
            assert!(peaked > flat * 2.0, "{mode:?} {flat} -> {peaked}");
        }
    }

    #[test]
    fn full_resonance_sweeps_stay_bounded() {
        for mode in [FilterMode::LowPass24, FilterMode::LowPass12, FilterMode::BandPass12, FilterMode::HighPass12] {
            let mut filter = Filter::new();
            filter.set_mode(mode);
            filter.reset(cutoff_gain(100.0, SR), 1.0);
            let mut peak = 0.0f32;
            for block in 0..3_000 {
                let mut buf = [0.0f32; 16];
                for (i, x) in buf.iter_mut().enumerate() {
                    *x = if (block * 16 + i) % 200 < 100 { 1.0 } else { -1.0 };
                }
                // Cutoff sweeps up and down over the whole range, as a fast LFO would.
                let t = sin_turns(block as f32 / 400.0);
                filter.process(&mut buf, cutoff_gain(libm::exp2f(7.0 + 7.0 * t) * 20.0, SR), 1.0, 1.0);
                for x in buf {
                    assert!(x.is_finite());
                    peak = peak.max(x.abs());
                }
            }
            assert!(peak < 20.0, "{mode:?} peak {peak}");
        }
    }

    #[test]
    fn off_only_drives() {
        let mut filter = Filter::new();
        let mut buf = [0.5f32; 16];
        filter.process(&mut buf, 0.1, 0.0, 0.0);
        assert!(buf.iter().all(|&x| x == 0.5));
        filter.process(&mut buf, 0.1, 0.0, 1.0);
        assert!(buf.iter().all(|&x| x != 0.5 && x < 0.5));
    }
}
