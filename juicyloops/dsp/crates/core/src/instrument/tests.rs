use super::*;
use alloc::vec;
use alloc::vec::Vec;

const SR: f32 = 48_000.0;

fn render(inst: &mut Instrument, start: i64, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0.0; frames];
    let mut r = vec![0.0; frames];
    inst.render(start, &mut l, &mut r);
    (l, r)
}

fn rms(buf: &[f32]) -> f32 {
    libm::sqrtf(buf.iter().map(|s| s * s).sum::<f32>() / buf.len() as f32)
}

fn estimate_hz(buf: &[f32]) -> f32 {
    let crossings: Vec<f32> = (1..buf.len())
        .filter(|&i| buf[i - 1] < 0.0 && buf[i] >= 0.0)
        .map(|i| i as f32 - buf[i] / (buf[i] - buf[i - 1]))
        .collect();
    SR * (crossings.len() - 1) as f32 / (crossings[crossings.len() - 1] - crossings[0])
}

/// Brightness: the level of the first difference relative to the level, high for a bright wave.
fn rough(buf: &[f32]) -> f32 {
    let diff: Vec<f32> = buf.windows(2).map(|w| w[1] - w[0]).collect();
    rms(&diff) / rms(buf)
}

fn analog() -> Instrument {
    Instrument::new(SR, Model::Analog)
}

fn set(inst: &mut Instrument, id: u32, value: f32) {
    assert!(inst.set_param(0, id, value));
}

#[test]
fn silent_without_notes() {
    let mut inst = analog();
    let (l, r) = render(&mut inst, 0, 1_000);
    assert!(l.iter().chain(&r).all(|&s| s == 0.0));
    assert_eq!(inst.render(1_000, &mut [0.0; 128], &mut [0.0; 128]), 0);
}

#[test]
fn a_note_sounds_at_its_pitch_starting_on_its_frame() {
    let mut inst = analog();
    set(&mut inst, OSC + OSC_WAVE, 0.0);
    set(&mut inst, FILTER_TYPE, 0.0);
    assert!(inst.note_on(1_000, 0, 440.0, 1.0, 24_000));
    let (l, r) = render(&mut inst, 0, 30_000);
    assert!(l[..1_000].iter().all(|&s| s == 0.0));
    assert!(l[1_001..1_100].iter().any(|&s| s != 0.0));
    let hz = estimate_hz(&l[5_000..20_000]);
    assert!((hz - 440.0).abs() < 0.2, "{hz}");
    assert_eq!(l, r, "one copy, centred: both sides alike");
}

#[test]
fn oscillator_octave_and_semitones_transpose() {
    let mut inst = analog();
    set(&mut inst, OSC + OSC_WAVE, 0.0);
    set(&mut inst, OSC + OSC_OCTAVE, -1.0);
    set(&mut inst, OSC + OSC_SEMI, 7.0);
    set(&mut inst, FILTER_TYPE, 0.0);
    inst.note_on(0, 0, 440.0, 1.0, 48_000);
    let (l, _) = render(&mut inst, 0, 24_000);
    let expected = 220.0 * libm::exp2f(7.0 / 12.0);
    assert!((estimate_hz(&l[4_000..]) - expected).abs() < 0.3);
}

#[test]
fn the_low_pass_darkens_a_saw() {
    let bright = {
        let mut inst = analog();
        inst.note_on(0, 0, 110.0, 1.0, 48_000);
        render(&mut inst, 0, 24_000).0
    };
    let dark = {
        let mut inst = analog();
        set(&mut inst, CUTOFF, 300.0);
        inst.note_on(0, 0, 110.0, 1.0, 48_000);
        render(&mut inst, 0, 24_000).0
    };
    assert!(rough(&dark[4_000..]) < rough(&bright[4_000..]) * 0.5);
}

#[test]
fn the_filter_envelope_opens_and_closes() {
    let mut inst = analog();
    set(&mut inst, CUTOFF, 100.0);
    set(&mut inst, FILTER_ENV, 1.0);
    set(&mut inst, FILTER_ATTACK, 0.001);
    set(&mut inst, FILTER_DECAY, 0.5);
    set(&mut inst, FILTER_SUSTAIN, 0.0);
    set(&mut inst, AMP_SUSTAIN, 1.0);
    inst.note_on(0, 0, 110.0, 1.0, 96_000);
    let (l, _) = render(&mut inst, 0, 48_000);
    assert!(rough(&l[500..3_000]) > rough(&l[40_000..]) * 3.0, "{} {}", rough(&l[500..3_000]), rough(&l[40_000..]));
}

#[test]
fn unison_spreads_into_stereo() {
    let mut inst = analog();
    set(&mut inst, UNISON, 5.0);
    set(&mut inst, UNISON_SPREAD, 1.0);
    inst.note_on(0, 0, 220.0, 1.0, 48_000);
    let (l, r) = render(&mut inst, 0, 24_000);
    let diff: Vec<f32> = l.iter().zip(&r).map(|(a, b)| a - b).collect();
    assert!(rms(&diff[4_000..]) > 0.05);
    // Stacking keeps about the loudness of one copy.
    let one = {
        let mut inst = analog();
        inst.note_on(0, 0, 220.0, 1.0, 48_000);
        rms(&render(&mut inst, 0, 24_000).0[4_000..])
    };
    let stacked = rms(&l[4_000..]);
    assert!(stacked > one * 0.5 && stacked < one * 1.6, "{one} vs {stacked}");
}

#[test]
fn an_lfo_on_pitch_makes_vibrato() {
    let mut inst = analog();
    set(&mut inst, OSC + OSC_WAVE, 0.0);
    set(&mut inst, FILTER_TYPE, 0.0);
    set(&mut inst, LFO + LFO_RATE, 4.0);
    set(&mut inst, LFO + LFO_DEST, Dest::Pitch as u32 as f32);
    set(&mut inst, LFO + LFO_AMOUNT, 1.0 / 12.0);
    inst.note_on(0, 0, 440.0, 1.0, 48_000);
    let (l, _) = render(&mut inst, 0, 48_000);
    // A quarter cycle in (the LFO's top) the pitch is a semitone up; three quarters in, one down.
    let up = estimate_hz(&l[2_500..3_500]);
    let down = estimate_hz(&l[8_500..9_500]);
    assert!(up > 455.0 && down < 425.0, "{up} {down}");
}

#[test]
fn the_matrix_routes_the_mod_wheel() {
    let mut inst = analog();
    set(&mut inst, MATRIX, Source::ModWheel as u32 as f32);
    set(&mut inst, MATRIX + 1, Dest::Volume as u32 as f32);
    set(&mut inst, MATRIX + 2, -1.0);
    set(&mut inst, AMP_SUSTAIN, 1.0);
    inst.note_on(0, 0, 220.0, 1.0, 96_000);
    let loud = rms(&render(&mut inst, 0, 24_000).0[4_000..]);
    inst.set_param(24_000, MOD_WHEEL, 1.0);
    let (quiet, _) = render(&mut inst, 24_000, 24_000);
    assert!(loud > 0.1);
    assert!(rms(&quiet[1_000..]) < loud * 0.01);
}

#[test]
fn notes_release_after_their_duration_and_fall_silent() {
    let mut inst = analog();
    set(&mut inst, AMP_RELEASE, 0.05);
    inst.note_on(0, 0, 440.0, 1.0, 4_800);
    let (l, _) = render(&mut inst, 0, 24_000);
    assert!(rms(&l[4_000..4_800]) > 0.1);
    assert!(l[12_000..].iter().all(|&s| s == 0.0));
    assert_eq!(inst.active_voices(), 0);
}

#[test]
fn held_notes_wait_for_their_note_off() {
    let mut inst = analog();
    set(&mut inst, AMP_RELEASE, 0.01);
    inst.note_on(0, 5, 440.0, 1.0, -1);
    render(&mut inst, 0, 48_000);
    assert_eq!(inst.active_voices(), 1);
    assert!(!inst.note_off(48_000, 0));
    assert!(inst.note_off(48_000, 5));
    render(&mut inst, 48_000, 4_800);
    assert_eq!(inst.active_voices(), 0);
}

#[test]
fn poly_overlaps_and_mono_takes_over() {
    let mut inst = analog();
    inst.note_on(0, 0, 440.0, 1.0, 24_000);
    inst.note_on(1_000, 0, 660.0, 1.0, 24_000);
    render(&mut inst, 0, 2_000);
    assert_eq!(inst.active_voices(), 2);

    let mut inst = analog();
    inst.set_mono(true);
    set(&mut inst, AMP_RELEASE, 0.01);
    inst.note_on(0, 0, 440.0, 1.0, 24_000);
    inst.note_on(1_000, 0, 660.0, 1.0, 24_000);
    render(&mut inst, 0, 2_000);
    assert_eq!(inst.active_voices(), 1);
}

#[test]
fn glide_slides_from_the_last_note() {
    let mut inst = analog();
    inst.set_mono(true);
    set(&mut inst, OSC + OSC_WAVE, 0.0);
    set(&mut inst, FILTER_TYPE, 0.0);
    set(&mut inst, GLIDE, 0.2);
    inst.note_on(0, 0, 220.0, 1.0, 96_000);
    inst.note_on(24_000, 0, 440.0, 1.0, 96_000);
    let (l, _) = render(&mut inst, 0, 48_000);
    let early = estimate_hz(&l[24_200..25_200]);
    let late = estimate_hz(&l[40_000..46_000]);
    assert!(early > 225.0 && early < 400.0, "{early}");
    assert!((late - 440.0).abs() < 2.0, "{late}");
}

#[test]
fn bend_shifts_every_voice() {
    let mut inst = analog();
    set(&mut inst, OSC + OSC_WAVE, 0.0);
    set(&mut inst, FILTER_TYPE, 0.0);
    set(&mut inst, BEND, 12.0);
    inst.note_on(0, 0, 220.0, 1.0, 48_000);
    let (l, _) = render(&mut inst, 0, 24_000);
    assert!((estimate_hz(&l[4_000..]) - 440.0).abs() < 0.5);
}

#[test]
fn velocity_sets_the_level() {
    let level = |velocity: f32| {
        let mut inst = analog();
        inst.note_on(0, 0, 440.0, velocity, 48_000);
        rms(&render(&mut inst, 0, 24_000).0[4_800..])
    };
    assert!((level(0.5) / level(1.0) - 0.5).abs() < 0.02);
}

#[test]
fn heavy_patches_stay_finite() {
    for model in [Model::Analog, Model::Wavetable, Model::Fm] {
        let mut inst = Instrument::new(SR, model);
        for (id, value) in [(UNISON, 7.0), (RESONANCE, 1.0), (DRIVE, 1.0), (NOISE, 1.0), (SUB, 1.0), (FILTER_ENV, 1.0), (FM_FEEDBACK, 1.0)] {
            set(&mut inst, id, value);
        }
        for i in 0..16 {
            inst.note_on(i * 50, 0, 30.0 * (1 + i) as f32, 1.0, 20_000);
        }
        let (l, r) = render(&mut inst, 0, 48_000);
        assert!(l.iter().chain(&r).all(|s| s.is_finite() && s.abs() < 64.0), "{model:?}");
    }
}
