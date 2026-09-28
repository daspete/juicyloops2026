//! JuicyLoops DSP core: `no_std` + `alloc` building blocks shared by the WASM worklets, and the polyphonic synth
//! voice engine built from them.
//!
//! Everything here is allocation-free on the audio path and deterministic, so it can be unit tested on
//! the host with `cargo test` and compiled unchanged for `wasm32-unknown-unknown`.

#![no_std]

extern crate alloc;

pub mod envelope;
pub mod oscillator;
pub mod smoother;
pub mod synth;

pub use envelope::{Adsr, AdsrParams, Stage};
pub use oscillator::{PolyBlepOsc, Waveform};
pub use smoother::OnePole;
pub use synth::{Param, Synth, MAX_EVENTS, MAX_VOICES};
