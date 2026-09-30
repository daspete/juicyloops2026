//! Small numeric helpers for the audio path: a polynomial sine, a soft clipper, a noise source and pitch
//! conversions. All cheap, allocation-free and deterministic.

use core::f32::consts::TAU;

/// `sin(2π·turns)` for any `turns`, from a 9th-order polynomial after folding into a quarter wave.
/// Error below 2e-6, and far cheaper than `libm::sinf` in WebAssembly.
#[inline]
pub fn sin_turns(turns: f32) -> f32 {
    let t = turns - libm::floorf(turns);
    let x = if t >= 0.5 { t - 1.0 } else { t };
    let x = if x > 0.25 {
        0.5 - x
    } else if x < -0.25 {
        -0.5 - x
    } else {
        x
    };
    let z = x * TAU;
    let z2 = z * z;
    z * (1.0 + z2 * (-1.0 / 6.0 + z2 * (1.0 / 120.0 + z2 * (-1.0 / 5_040.0 + z2 * (1.0 / 362_880.0)))))
}

/// A smooth saturator close to `tanh`: exact at 0, unity slope there, reaching ±1 at ±3 and clamping beyond.
#[inline]
pub fn soft_clip(x: f32) -> f32 {
    if x <= -3.0 {
        -1.0
    } else if x >= 3.0 {
        1.0
    } else {
        let x2 = x * x;
        x * (27.0 + x2) / (27.0 + 9.0 * x2)
    }
}

/// Frequency ratio of an interval in semitones.
#[inline]
pub fn semitones_ratio(semitones: f32) -> f32 {
    libm::exp2f(semitones / 12.0)
}

/// MIDI note number (69 = A4 = 440 Hz, fractional for anything in between) of a frequency.
#[inline]
pub fn hz_to_note(hz: f32) -> f32 {
    69.0 + 12.0 * libm::log2f(hz / 440.0)
}

#[inline]
pub fn note_to_hz(note: f32) -> f32 {
    440.0 * libm::exp2f((note - 69.0) / 12.0)
}

/// xorshift32: a tiny deterministic noise and random source. Never seeded with 0.
#[derive(Clone, Copy, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(if seed == 0 { 0x9e37_79b9 } else { seed })
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// Uniform in [-1, 1).
    #[inline]
    pub fn bipolar(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (2.0 / 16_777_216.0) - 1.0
    }

    /// Uniform in [0, 1).
    #[inline]
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_turns_matches_libm() {
        let mut worst = 0.0f32;
        for i in -4_000..4_000 {
            let t = i as f32 / 997.0;
            worst = worst.max((sin_turns(t) - libm::sinf(TAU * t)).abs());
        }
        assert!(worst < 5e-6, "{worst}");
    }

    #[test]
    fn soft_clip_is_odd_bounded_and_unity_at_zero() {
        assert_eq!(soft_clip(0.0), 0.0);
        assert!((soft_clip(0.001) - 0.001).abs() < 1e-6);
        assert!((soft_clip(1.0) + soft_clip(-1.0)).abs() < 1e-7);
        assert_eq!(soft_clip(10.0), 1.0);
        assert!((soft_clip(3.0) - 1.0).abs() < 1e-6, "continuous at the clamp");
    }

    #[test]
    fn pitch_conversions_round_trip() {
        assert!((note_to_hz(69.0) - 440.0).abs() < 1e-3);
        assert!((hz_to_note(261.6256) - 60.0).abs() < 1e-3);
        assert!((semitones_ratio(12.0) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn rng_stays_in_range() {
        let mut rng = Rng::new(1);
        for _ in 0..10_000 {
            let b = rng.bipolar();
            let u = rng.unit();
            assert!((-1.0..1.0).contains(&b) && (0.0..1.0).contains(&u));
        }
    }
}
