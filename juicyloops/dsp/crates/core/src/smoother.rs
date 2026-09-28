//! One-pole parameter smoother (exponential approach to a target), to avoid zipper noise.

/// Distance to the target below which the smoother jumps onto it.
const SETTLED: f32 = 1.0e-6;

#[derive(Clone, Debug)]
pub struct OnePole {
    value: f32,
    target: f32,
    coeff: f32,
}

impl OnePole {
    /// `time_s` is the time constant (63 % of the way to the target).
    pub fn new(sample_rate: f32, time_s: f32, initial: f32) -> Self {
        let mut s = Self { value: initial, target: initial, coeff: 0.0 };
        s.set_time(sample_rate, time_s);
        s
    }

    pub fn set_time(&mut self, sample_rate: f32, time_s: f32) {
        self.coeff = if time_s <= 0.0 { 0.0 } else { libm::expf(-1.0 / (time_s * sample_rate)) };
    }

    pub fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    pub fn jump(&mut self, value: f32) {
        self.value = value;
        self.target = value;
    }

    #[inline]
    pub fn next_sample(&mut self) -> f32 {
        let distance = (self.value - self.target) * self.coeff;
        let next = self.target + distance;
        // Snap once inaudibly close (or when f32 rounding stops the approach a few ulps short), so the value settles
        // exactly and never drifts into denormals.
        self.value = if distance.abs() < SETTLED || next == self.value { self.target } else { next };
        self.value
    }

    pub fn target(&self) -> f32 {
        self.target
    }

    pub fn is_settled(&self) -> bool {
        self.value == self.target
    }

    pub fn value(&self) -> f32 {
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaches_63_percent_after_one_time_constant() {
        let mut s = OnePole::new(1_000.0, 0.01, 0.0);
        s.set_target(1.0);
        for _ in 0..10 {
            s.next_sample();
        }
        assert!((s.value() - 0.632).abs() < 0.01, "{}", s.value());
    }

    #[test]
    fn settles_exactly() {
        let mut s = OnePole::new(48_000.0, 0.005, 0.0);
        s.set_target(0.7);
        for _ in 0..48_000 {
            s.next_sample();
        }
        assert!(s.is_settled());
        assert_eq!(s.value(), 0.7);
    }

    #[test]
    fn zero_time_jumps() {
        let mut s = OnePole::new(48_000.0, 0.0, 0.0);
        s.set_target(0.5);
        assert_eq!(s.next_sample(), 0.5);
    }
}
