//! Band-limited oscillators using polyBLEP (saw, square) and polyBLAMP (triangle) corrections.

use core::f32::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Waveform {
    Sine = 0,
    Square = 1,
    Triangle = 2,
    Sawtooth = 3,
}

impl Waveform {
    pub fn from_u32(value: u32) -> Self {
        match value {
            1 => Waveform::Square,
            2 => Waveform::Triangle,
            3 => Waveform::Sawtooth,
            _ => Waveform::Sine,
        }
    }
}

/// Polynomial band-limited step residual. `t` is the phase in [0, 1), `dt` the phase increment.
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

/// Polynomial band-limited ramp residual (integrated polyBLEP), used for slope discontinuities.
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

#[derive(Clone, Debug)]
pub struct PolyBlepOsc {
    pub waveform: Waveform,
    phase: f32,
    dt: f32,
    sample_rate: f32,
}

impl PolyBlepOsc {
    pub fn new(sample_rate: f32, waveform: Waveform) -> Self {
        Self { waveform, phase: 0.0, dt: 0.0, sample_rate }
    }

    pub fn set_frequency(&mut self, hz: f32) {
        // Clamp below Nyquist so the BLEP windows never overlap.
        self.dt = (hz / self.sample_rate).clamp(0.0, 0.49);
    }

    pub fn reset(&mut self, phase: f32) {
        self.phase = phase - libm::floorf(phase);
    }

    pub fn phase(&self) -> f32 {
        self.phase
    }

    #[inline]
    pub fn next_sample(&mut self) -> f32 {
        let t = self.phase;
        let dt = self.dt;
        let out = match self.waveform {
            Waveform::Sine => libm::sinf(TAU * t),
            Waveform::Sawtooth => (2.0 * t - 1.0) - poly_blep(t, dt),
            Waveform::Square => {
                let naive = if t < 0.5 { 1.0 } else { -1.0 };
                let mut t2 = t + 0.5;
                if t2 >= 1.0 {
                    t2 -= 1.0;
                }
                naive + poly_blep(t, dt) - poly_blep(t2, dt)
            }
            Waveform::Triangle => {
                // Naive triangle peaks at t = 0.25 and dips at t = 0.75; each corner is a slope change of 8.
                let naive = if t < 0.25 {
                    4.0 * t
                } else if t < 0.75 {
                    2.0 - 4.0 * t
                } else {
                    4.0 * t - 4.0
                };
                let mut t_top = t + 0.75;
                if t_top >= 1.0 {
                    t_top -= 1.0;
                }
                let mut t_bottom = t + 0.25;
                if t_bottom >= 1.0 {
                    t_bottom -= 1.0;
                }
                naive + 8.0 * dt * (poly_blamp(t_bottom, dt) - poly_blamp(t_top, dt))
            }
        };
        self.phase += dt;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        out
    }

    pub fn render(&mut self, out: &mut [f32]) {
        for sample in out.iter_mut() {
            *sample = self.next_sample();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;

    const SR: f32 = 48_000.0;

    fn render(waveform: Waveform, hz: f32, frames: usize) -> Vec<f32> {
        let mut osc = PolyBlepOsc::new(SR, waveform);
        osc.set_frequency(hz);
        let mut buf = vec![0.0; frames];
        osc.render(&mut buf);
        buf
    }

    /// Frequency estimated from rising zero crossings over the buffer.
    fn estimate_hz(buf: &[f32]) -> f32 {
        let crossings: Vec<usize> =
            (1..buf.len()).filter(|&i| buf[i - 1] < 0.0 && buf[i] >= 0.0).collect();
        let periods = (crossings.len() - 1) as f32;
        let span = (crossings[crossings.len() - 1] - crossings[0]) as f32;
        SR * periods / span
    }

    #[test]
    fn frequency_matches_for_every_waveform() {
        for waveform in [Waveform::Sine, Waveform::Square, Waveform::Triangle, Waveform::Sawtooth] {
            for hz in [55.0, 440.0, 3_000.0] {
                let est = estimate_hz(&render(waveform, hz, 48_000));
                assert!((est - hz).abs() / hz < 0.002, "{waveform:?} {hz} Hz estimated {est}");
            }
        }
    }

    #[test]
    fn level_is_bounded_and_dc_free() {
        for waveform in [Waveform::Sine, Waveform::Square, Waveform::Triangle, Waveform::Sawtooth] {
            let buf = render(waveform, 440.0, 48_000);
            let peak = buf.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            let mean = buf.iter().sum::<f32>() / buf.len() as f32;
            assert!(peak > 0.9 && peak <= 1.05, "{waveform:?} peak {peak}");
            assert!(mean.abs() < 0.01, "{waveform:?} dc {mean}");
        }
    }

    #[test]
    fn saw_step_is_band_limited() {
        // A naive saw jumps by 2.0 at the wrap; polyBLEP spreads it over two samples.
        let buf = render(Waveform::Sawtooth, 1_000.0, 4_800);
        let max_jump = buf.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(max_jump < 1.5, "max jump {max_jump}");
    }

    #[test]
    fn square_rms_is_close_to_one() {
        let buf = render(Waveform::Square, 100.0, 48_000);
        let rms = libm::sqrtf(buf.iter().map(|s| s * s).sum::<f32>() / buf.len() as f32);
        assert!((rms - 1.0).abs() < 0.02, "rms {rms}");
    }
}
