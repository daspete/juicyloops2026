//! A small radix-2 FFT for building wavetables: complex in place, and real forward / inverse transforms of twice
//! the complex size via the usual packing trick. Unnormalized forward, normalized inverse (a round trip gives the
//! input back). The twiddle table is allocated once in `new`; the transforms never allocate.

use alloc::vec::Vec;
use core::f64::consts::TAU;

pub struct Fft {
    size: usize,
    /// `cos` and `sin` of `2π·k/size` for `k` in `0..=size/2`.
    cos: Vec<f32>,
    sin: Vec<f32>,
}

impl Fft {
    /// Transforms of up to `size` points (a power of two, at least 4): complex ones of up to `size`, real ones of
    /// up to `size`.
    pub fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 4);
        let angle = |k: usize| TAU * k as f64 / size as f64;
        let cos = (0..=size / 2).map(|k| libm::cos(angle(k)) as f32).collect();
        let sin = (0..=size / 2).map(|k| libm::sin(angle(k)) as f32).collect();
        Self { size, cos, sin }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    /// In-place complex transform of `re.len()` (a power of two, at most `size`) points. The inverse is not
    /// normalized.
    pub fn complex(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        let n = re.len();
        debug_assert!(n.is_power_of_two() && n <= self.size && im.len() == n);
        if n <= 1 {
            return;
        }
        let mut j = 0;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j |= bit;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let stride = self.size / len;
            let mut start = 0;
            while start < n {
                for k in 0..half {
                    let wr = self.cos[k * stride];
                    let wi = if inverse { self.sin[k * stride] } else { -self.sin[k * stride] };
                    let a = start + k;
                    let b = a + half;
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
                start += len;
            }
            len <<= 1;
        }
    }

    /// Spectrum of the real signal `x` (`N` = `x.len()` points, a power of two up to `size`): bins `0..=N/2` into
    /// `re`/`im`. `work_re`/`work_im` hold at least `N/2` values.
    pub fn real_forward(&self, x: &[f32], re: &mut [f32], im: &mut [f32], work_re: &mut [f32], work_im: &mut [f32]) {
        let big_n = x.len();
        let n = big_n / 2;
        let (wr, wi) = (&mut work_re[..n], &mut work_im[..n]);
        for m in 0..n {
            wr[m] = x[2 * m];
            wi[m] = x[2 * m + 1];
        }
        self.complex(wr, wi, false);
        let stride = self.size / big_n;
        for k in 0..=n {
            let a = k % n;
            let b = (n - k) % n;
            let (zr, zi) = (wr[a], wi[a]);
            let (cr, ci) = (wr[b], -wi[b]);
            let (er, ei) = (0.5 * (zr + cr), 0.5 * (zi + ci));
            // (Z - conj Z[n-k]) / 2i
            let (or, oi) = (0.5 * (zi - ci), -0.5 * (zr - cr));
            let c = self.cos[k * stride];
            let s = -self.sin[k * stride];
            re[k] = er + c * or - s * oi;
            im[k] = ei + c * oi + s * or;
        }
    }

    /// The real signal (`x.len()` = `N` points) whose bins `0..=N/2` are `re`/`im`: the inverse of `real_forward`.
    pub fn real_inverse(&self, re: &[f32], im: &[f32], x: &mut [f32], work_re: &mut [f32], work_im: &mut [f32]) {
        let big_n = x.len();
        let n = big_n / 2;
        let (wr, wi) = (&mut work_re[..n], &mut work_im[..n]);
        let stride = self.size / big_n;
        for k in 0..n {
            let (xr, xi) = (re[k], im[k]);
            let (cr, ci) = (re[n - k], -im[n - k]);
            let (er, ei) = (0.5 * (xr + cr), 0.5 * (xi + ci));
            let (dr, di) = (0.5 * (xr - cr), 0.5 * (xi - ci));
            let c = self.cos[k * stride];
            let s = self.sin[k * stride];
            let (or, oi) = (dr * c - di * s, dr * s + di * c);
            wr[k] = er - oi;
            wi[k] = ei + or;
        }
        self.complex(wr, wi, true);
        let scale = 1.0 / n as f32;
        for m in 0..n {
            x[2 * m] = wr[m] * scale;
            x[2 * m + 1] = wi[m] * scale;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::sin_turns;
    use alloc::vec;

    #[test]
    fn complex_sine_lands_in_its_bin() {
        let fft = Fft::new(64);
        let mut re: Vec<f32> = (0..64).map(|i| libm::cosf(core::f32::consts::TAU * 5.0 * i as f32 / 64.0)).collect();
        let mut im = vec![0.0; 64];
        fft.complex(&mut re, &mut im, false);
        for k in 0..64 {
            let mag = libm::sqrtf(re[k] * re[k] + im[k] * im[k]);
            let expected = if k == 5 || k == 59 { 32.0 } else { 0.0 };
            assert!((mag - expected).abs() < 1e-3, "bin {k}: {mag}");
        }
    }

    #[test]
    fn real_sine_has_its_spectrum_and_round_trips() {
        let fft = Fft::new(2048);
        for n in [8usize, 64, 1024, 2048] {
            let x: Vec<f32> = (0..n).map(|i| 0.5 * sin_turns(3.0 * i as f32 / n as f32) + 0.25 * sin_turns(i as f32 / n as f32 + 0.1) + 0.1).collect();
            let (mut re, mut im) = (vec![0.0; n / 2 + 1], vec![0.0; n / 2 + 1]);
            let (mut wr, mut wi) = (vec![0.0; n / 2], vec![0.0; n / 2]);
            fft.real_forward(&x, &mut re, &mut im, &mut wr, &mut wi);
            assert!((re[0] - 0.1 * n as f32).abs() < 1e-3 * n as f32, "dc");
            assert!((im[3] + 0.25 * n as f32).abs() < 1e-3 * n as f32, "a sine is -i·a·N/2 at its bin");
            for k in 4..=n / 2 {
                assert!(re[k].abs() + im[k].abs() < 1e-3 * n as f32, "n {n} bin {k}");
            }
            let mut back = vec![0.0; n];
            fft.real_inverse(&re, &im, &mut back, &mut wr, &mut wi);
            for (a, b) in x.iter().zip(&back) {
                assert!((a - b).abs() < 1e-4, "n {n}: {a} vs {b}");
            }
        }
    }
}
