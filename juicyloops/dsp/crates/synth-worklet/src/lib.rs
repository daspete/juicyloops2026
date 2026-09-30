//! Synth voice engine for an AudioWorklet, exported through a plain C ABI (no wasm-bindgen glue, no imports).
//! The engine itself is `juicyloops_dsp_core::Synth`; this crate is the ABI around it. The host side is
//! `frontend/src/juicyloops/dsp/synthProcessor.ts`.
//!
//! Host contract (ABI version 4):
//! 1. `init(sample_rate, kind)` once after instantiation. `kind` picks the engine: 0 the classic `Synth` (one
//!    oscillator + ADSR), 1 analog, 2 wavetable, 3 FM (the `Instrument` models).
//! 2. `out_ptr()` points at `2 * MAX_BLOCK` f32s in linear memory: the left channel, then the right. The host views
//!    it as a Float32Array. Memory never grows after `init`, so the view stays valid.
//! 3. Events carry absolute frames (the audio context's frame counter, `currentFrame`), passed as whole numbers in
//!    f64 so JS needs no BigInt:
//!    - `note_on(frame, id, hz, velocity, duration_frames)`: a note from `frame`, released `duration_frames` later,
//!      or held until `note_off(frame, id)` when `duration_frames` is negative. `id` 0 is "no id" (scheduled notes);
//!    - `note_off(frame, id)`: releases every held voice playing note `id` (id 0 is ignored and returns 0);
//!    - `set_param(frame, id, value)`: for the classic engine, ids as in `juicyloops_dsp_core::Param` (0 waveform,
//!      1 attack s, 2 decay s, 3 sustain level, 4 release s, 5 pitch bend in semitones); for the others, patch ids
//!      as in `juicyloops_dsp_core::instrument::params`;
//!    all return 1 when queued, 0 when rejected (invalid, or the queue is full).
//!    - `set_mode(mono)`: 1 = notes cut (one voice, legato), 0 = notes overlap (16 voices). Applies at once.
//! 4. `process(start_frame, frames)` renders `frames` (<= `MAX_BLOCK`) stereo frames starting at `start_frame`
//!    into the out buffer (the classic engine is mono and writes the same to both sides). It returns the number of sounding voices plus queued events: 0 means silence until the next
//!    event, so the host may skip calls until it sends one.

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::boxed::Box;
use juicyloops_dsp_core::{Instrument, Model, Synth};
pub use juicyloops_dsp_core::synth::MAX_BLOCK;

#[cfg(target_arch = "wasm32")]
mod wasm_rt;

/// Bumped whenever an export changes shape. The processor checks it after instantiation.
pub const ABI_VERSION: u32 = 4;

enum Voices {
    Classic(Synth),
    Instrument(Instrument),
}

pub struct Engine {
    voices: Voices,
    out: [f32; 2 * MAX_BLOCK],
}

impl Engine {
    fn new(sample_rate: f32, kind: u32) -> Self {
        let model = match kind {
            1 => Some(Model::Analog),
            2 => Some(Model::Wavetable),
            3 => Some(Model::Fm),
            _ => None,
        };
        let voices = match model {
            Some(model) => Voices::Instrument(Instrument::new(sample_rate, model)),
            None => Voices::Classic(Synth::new(sample_rate)),
        };
        Self { voices, out: [0.0; 2 * MAX_BLOCK] }
    }
}

// The AudioWorklet instantiates one module instance per node and calls it from a single thread, so a single global
// engine per instance is enough.
static mut ENGINE: Option<Box<Engine>> = None;

#[allow(static_mut_refs)]
fn engine() -> Option<&'static mut Engine> {
    // SAFETY: wasm instances are single-threaded and the host never re-enters an export.
    unsafe { ENGINE.as_deref_mut() }
}

/// Whole frames arrive as f64 (exact up to 2^53); `as` saturates anything out of range.
fn frame(value: f64) -> i64 {
    value as i64
}

#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn init(sample_rate: f32, kind: u32) {
    // SAFETY: see `engine()`. Allocated once; the bump allocator never frees, so `init` is meant to run once.
    unsafe { ENGINE = Some(Box::new(Engine::new(sample_rate, kind))) };
}

#[unsafe(no_mangle)]
pub extern "C" fn out_ptr() -> *mut f32 {
    engine().map_or(core::ptr::null_mut(), |e| e.out.as_mut_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn note_on(start_frame: f64, id: u32, hz: f32, velocity: f32, duration_frames: f64) -> u32 {
    engine().is_some_and(|e| match &mut e.voices {
        Voices::Classic(synth) => synth.note_on(frame(start_frame), id, hz, velocity, frame(duration_frames)),
        Voices::Instrument(inst) => inst.note_on(frame(start_frame), id, hz, velocity, frame(duration_frames)),
    }) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn note_off(at_frame: f64, id: u32) -> u32 {
    engine().is_some_and(|e| match &mut e.voices {
        Voices::Classic(synth) => synth.note_off(frame(at_frame), id),
        Voices::Instrument(inst) => inst.note_off(frame(at_frame), id),
    }) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn set_param(at_frame: f64, id: u32, value: f32) -> u32 {
    engine().is_some_and(|e| match &mut e.voices {
        Voices::Classic(synth) => synth.set_param(frame(at_frame), id, value),
        Voices::Instrument(inst) => inst.set_param(frame(at_frame), id, value),
    }) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn set_mode(mono: u32) {
    if let Some(e) = engine() {
        match &mut e.voices {
            Voices::Classic(synth) => synth.set_mono(mono != 0),
            Voices::Instrument(inst) => inst.set_mono(mono != 0),
        }
    }
}

/// Renders `frames` stereo frames from `start_frame` into the out buffer; returns what is still going on (see above).
#[unsafe(no_mangle)]
pub extern "C" fn process(start_frame: f64, frames: u32) -> u32 {
    let Some(e) = engine() else { return 0 };
    let frames = (frames as usize).min(MAX_BLOCK);
    let (left, right) = e.out.split_at_mut(MAX_BLOCK);
    match &mut e.voices {
        Voices::Classic(synth) => {
            let busy = synth.render(frame(start_frame), &mut left[..frames]);
            right[..frames].copy_from_slice(&left[..frames]);
            busy
        }
        Voices::Instrument(inst) => inst.render(frame(start_frame), &mut left[..frames], &mut right[..frames]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out() -> &'static [f32] {
        // SAFETY: the test reads the buffer between calls, like the host does.
        unsafe { core::slice::from_raw_parts(out_ptr(), 2 * MAX_BLOCK) }
    }

    #[test]
    fn c_abi_round_trip() {
        init(48_000.0, 0);
        assert_eq!(abi_version(), ABI_VERSION);
        assert!(!out_ptr().is_null());
        assert_eq!(process(0.0, 128), 0);
        assert!(out().iter().all(|&s| s == 0.0));

        set_mode(1);
        assert_eq!(set_param(0.0, 3, 1.0), 1);
        assert_eq!(set_param(0.0, 42, 1.0), 0);
        assert_eq!(note_on(200.0, 0, 440.0, 1.0, 4_800.0), 1);
        assert_eq!(process(0.0, 128), 1, "the note waits in the queue");
        assert!(out().iter().all(|&s| s == 0.0));
        assert_eq!(process(128.0, 128), 1, "one voice sounds");
        assert_eq!(out()[..73].iter().filter(|&&s| s != 0.0).count(), 0);
        assert!(out()[73..].iter().any(|&s| s != 0.0));

        // A held note (negative duration) until its note_off; bend is param 5.
        set_mode(0);
        assert_eq!(note_on(256.0, 9, 220.0, 1.0, -1.0), 1);
        assert_eq!(set_param(256.0, 5, -2.0), 1);
        assert_eq!(note_off(256.0, 0), 0, "id 0 is never a live note");
        for block in 2..400 {
            process(block as f64 * 128.0, 128);
        }
        assert!(out().iter().any(|&s| s != 0.0), "the held note still sounds");
        assert_eq!(note_off(400.0 * 128.0, 9), 1);
        let mut busy = 1;
        for block in 400..1_000 {
            busy = process(block as f64 * 128.0, 128);
        }
        assert_eq!(busy, 0, "released and silent");

        // The analog engine: stereo out, patch ids.
        init(48_000.0, 1);
        assert_eq!(set_param(0.0, 6, 3.0), 1, "unison");
        assert_eq!(set_param(0.0, 8, 1.0), 1, "spread");
        assert_eq!(set_param(0.0, 140, 1.0), 0, "outside the patch");
        assert_eq!(note_on(0.0, 0, 220.0, 1.0, 48_000.0), 1);
        for block in 0..20 {
            assert!(process(block as f64 * 128.0, 128) > 0);
        }
        let (left, right) = out().split_at(MAX_BLOCK);
        assert!(left.iter().any(|&s| s != 0.0));
        assert_ne!(left, right, "unison spread is stereo");
    }
}
