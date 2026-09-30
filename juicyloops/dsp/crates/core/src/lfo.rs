//! Low-frequency oscillator for modulation: bipolar output (-1..=1), advanced at control rate.

use crate::math::{sin_turns, Rng};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LfoShape {
    Sine = 0,
    Triangle = 1,
    SawUp = 2,
    SawDown = 3,
    Square = 4,
    /// A new random level every cycle (sample and hold).
    Random = 5,
}

impl LfoShape {
    pub fn from_u32(value: u32) -> Self {
        match value {
            1 => LfoShape::Triangle,
            2 => LfoShape::SawUp,
            3 => LfoShape::SawDown,
            4 => LfoShape::Square,
            5 => LfoShape::Random,
            _ => LfoShape::Sine,
        }
    }
}

/// Note lengths a synced LFO cycle can take, in beats (quarter notes). Index 0 of the sync parameter is "free"
/// (rate in Hz), index `i` is `SYNC_BEATS[i - 1]`. The frontend lists the same divisions.
pub const SYNC_BEATS: [f32; 13] = [
    8.0,       // 2/1
    4.0,       // 1/1
    2.0,       // 1/2
    1.5,       // 1/4 dotted
    1.0,       // 1/4
    2.0 / 3.0, // 1/4 triplet
    0.75,      // 1/8 dotted
    0.5,       // 1/8
    1.0 / 3.0, // 1/8 triplet
    0.375,     // 1/16 dotted
    0.25,      // 1/16
    1.0 / 6.0, // 1/16 triplet
    0.125,     // 1/32
];

/// Cycles per second of an LFO: `hz` when free (`sync` 0), else one synced note length at `bpm`.
pub fn lfo_rate(hz: f32, sync: u32, bpm: f32) -> f32 {
    match sync.checked_sub(1).and_then(|i| SYNC_BEATS.get(i as usize)) {
        Some(beats) => bpm.max(1.0) / 60.0 / beats,
        None => hz,
    }
}

#[derive(Clone, Debug)]
pub struct Lfo {
    phase: f32,
    held: f32,
    rng: Rng,
}

impl Lfo {
    pub fn new(seed: u32) -> Self {
        let mut rng = Rng::new(seed);
        let held = rng.bipolar();
        Self { phase: 0.0, held, rng }
    }

    pub fn phase(&self) -> f32 {
        self.phase
    }

    /// Restarts the cycle at `phase` (0..1); a random LFO also picks a new level.
    pub fn reset(&mut self, phase: f32) {
        self.phase = phase - libm::floorf(phase);
        self.held = self.rng.bipolar();
    }

    /// The level at the current phase.
    #[inline]
    pub fn value(&self, shape: LfoShape) -> f32 {
        let t = self.phase;
        match shape {
            LfoShape::Sine => sin_turns(t),
            LfoShape::Triangle => {
                if t < 0.25 {
                    4.0 * t
                } else if t < 0.75 {
                    2.0 - 4.0 * t
                } else {
                    4.0 * t - 4.0
                }
            }
            LfoShape::SawUp => 2.0 * t - 1.0,
            LfoShape::SawDown => 1.0 - 2.0 * t,
            LfoShape::Square => {
                if t < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            LfoShape::Random => self.held,
        }
    }

    /// Moves on by `turns` of a cycle.
    #[inline]
    pub fn advance(&mut self, turns: f32) {
        self.phase += turns;
        if self.phase >= 1.0 {
            self.phase -= libm::floorf(self.phase);
            self.held = self.rng.bipolar();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_span_minus_one_to_one() {
        for shape in 0..6 {
            let shape = LfoShape::from_u32(shape);
            let mut lfo = Lfo::new(7);
            let (mut lo, mut hi) = (f32::MAX, f32::MIN);
            for _ in 0..4_000 {
                let v = lfo.value(shape);
                lo = lo.min(v);
                hi = hi.max(v);
                lfo.advance(0.01);
            }
            assert!(lo >= -1.0 - 1e-5 && hi <= 1.0 + 1e-5, "{shape:?}");
            assert!(hi - lo > 1.5, "{shape:?} spans {lo}..{hi}");
        }
    }

    #[test]
    fn synced_rate_follows_the_tempo() {
        assert_eq!(lfo_rate(3.0, 0, 120.0), 3.0);
        assert!((lfo_rate(3.0, 5, 120.0) - 2.0).abs() < 1e-6, "a quarter note at 120 bpm is 2 Hz");
        assert!((lfo_rate(3.0, 2, 120.0) - 0.5).abs() < 1e-6, "a bar at 120 bpm is 0.5 Hz");
        assert_eq!(lfo_rate(3.0, 99, 120.0), 3.0);
    }
}
