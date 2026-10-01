# New synths (Analog, FM, Wavetable) and WAM plugins

Paths are relative to `juicyloops/` unless noted. Decisions taken with the user on 2026-09-30:
plugins are **WAM 2.0** (Web Audio Modules, the browser's VST equivalent; native VSTs cannot load in a browser),
and three new synth models: **Analog**, **FM** and **Wavetable**.

## Shape of it

A synth track keeps being one track type (`synth`: notes, piano roll, live MIDI, bend, cut/overlap). What makes
the sound is its **model**:

| model | engine | where |
|---|---|---|
| `classic` | today's Rust `Synth` (one oscillator + ADSR), unchanged. Every existing project stays on it. | `dsp/crates/core/src/synth.rs` |
| `analog` | 3 polyBLEP oscillators + sub + noise, unison (detune, stereo spread), multimode filter, 2 envelopes, 2 LFOs, mod matrix, glide | `dsp/crates/core/src/instrument/` |
| `wavetable` | same voice, 2 wavetable oscillators with morphing position (8 built-in tables, band-limited mipmaps) | same |
| `fm` | same voice, 4 operators, 8 algorithms, feedback, per-operator envelopes | same |
| `plugin` | a WAM 2.0 instrument, loaded by URL | `frontend/src/juicyloops/plugins/` |

### Rust: one `Instrument` engine for analog / wavetable / fm

- Same event model as `Synth`: events stamped with absolute frames, sample-accurate, live notes with ids, bend.
- A flat patch of `PARAM_COUNT` f32s, set by id (`set_param`). Sections share ids across models, so the filter,
  envelopes, LFOs, matrix and globals are one code path; only the source (oscillator section) differs.
- Stereo out (unison spread, pan modulation). The worklet always outputs 2 channels; `classic` copies L to R.
- Modulation runs at control rate (every 16 frames), filter coefficients interpolate per sample.
- Filters: off, LP12/BP12/HP12/notch (TPT state-variable), LP24 (TPT 4-pole ladder with tanh drive).
- Mod sources: LFO1, LFO2, filter env, amp env, velocity, mod wheel, key, random per note.
  Destinations: pitch, osc 1/2 pitch, shape 1/2 (pulse width / table position / FM modulator level), cutoff,
  resonance, volume, pan, LFO rates, noise, osc mix. Each LFO has its own destination + amount; 4 free slots.
- LFO rate free (Hz) or synced to the tempo (host sends the BPM).

ABI v4 of `synth-worklet.wasm`: `init(sample_rate, kind)` (0 classic, 1 analog, 2 wavetable, 3 fm), stereo out
buffer, the rest as before.

### Frontend

- `juicyloops/synths/`: parameter tables per model (id, key, label, range, curve, format, group, default), factory
  presets per model. Params are automatable and MIDI-learnable through the normal track parameter API
  (`patch.<key>` keys).
- `SynthTrack`: `model`, `patch` (values by key), `setModel` rebuilds the engine. Snapshots without `model` are
  classic. The Tone fallback engine (insecure origin, no AudioWorklet) plays new models as a single oscillator
  with the amp envelope.
- UI: the instrument device card gets a model switch; each model has a panel (macro face: the main knobs; full
  face: every section).

### WAM 2.0 plugins

- Host: WAM env initialised on the *native* context behind Tone's standardized-audio-context wrapper; audio is
  bridged between the WAM node and Tone nodes via the wrapper's native node.
- Catalogue: the WAM community list (`https://www.webaudiomodules.com/community/plugins.json`, CORS-enabled),
  filtered to instruments and effects, plus "add by URL" (remembered locally). Plugins run third-party code in the
  page: the UI says so.
- Instrument: synth track model `plugin` (notes as `wam-midi` events, bend as MIDI pitch bend).
- Effect: a `plugin` slot kind in the effect rack.
- Plugin GUIs open in a floating window. State (`getState`) is cached on the track for undo, saves and offline
  renders; renders build a fresh instance on the offline context and restore the state.

## Status (2026-10-01)

All five phases are implemented and tested: 76 Rust tests, 301 unit tests, type-check, lint, production build and
prerender, plus browser checks at 1400 px and 390 px (live sound of every model, offline export of every model, the
plugin browser, a plugin instrument with its own window, a plugin effect in the rack).

Offline render speed with 8 overlapping voices (16 s of audio, Chromium): classic 26× real time, analog init 22×,
analog Warm pad 11×, analog Super saw (7-voice unison) 12×, wavetable Morph pad 14×, FM E. piano 17×.

## Stereo mix (2026-10-01)

Tracks and buses used Tone's `PanVol`, whose panner folds its input to one channel, so the whole mix was mono. They
now use `StereoPanVol` (`frontend/src/juicyloops/stereoPanVol.ts`): the volume stage up-mixes mono to two equal
sides, then each side gets its own gain on the old equal-power law (left × cos θ, right × sin θ). Checked by
offline renders before and after: a mono source is bit-for-bit as loud at every pan position (classic synth peak
0.351 at centre, 0.497 hard right, 0.459/0.19 at -0.5), and unison spread, stereo plugins, stereo samples and stereo
effects (reverb, chorus, ping-pong) now reach the master in stereo. Real stereo material is a bit louder than it was
folded down (uncorrelated sides, e.g. a reverb tail, up to +3 dB), which is the sound of the stereo itself. Render
speed unchanged.

## Curated plugins (2026-10-01)

Besides the community list, the browser offers plugins hosted elsewhere (`CURATED_PLUGINS` in
`plugins/catalog.ts`), each tested in the studio live and in an offline render:

| plugin | host | live | export |
|---|---|---|---|
| Pro-54, TX81Z, Electric Piano, Faust FM | cesaref.github.io/wam (Cmajor) | yes | silent: notes reach them through the main thread |
| OB-Xd, TinySynth (GM, no window) | mainline.i3s.unice.fr/wam2/packages | yes | yes |
| Guitar LSTM | Cmajor | yes | yes |
| Convolution Reverb, Filter EQ, Tremolo | Cmajor | yes | yes since 2026-10-01 (were silent: `WamEffect` left its input unreachable for standardized-audio-context's offline rendering; see `notes/vst-bridge.md`). The "Live only" badge is gone. |

Plugins that are silent in exports carry a "Live only" badge (also Synth-101 in the community list). Quadrafuzz
from the WAM team's host was left out: it duplicates the community one and is nearly silent in exports. A real-time
export mode (recording the master while the song plays) would make every live-only plugin exportable.

## Desktop plugins (2026-10-01)

Native VST3 and CLAP plugins play through the Juicy Loops Bridge desktop app, as `PluginRef`s with a `vstbridge:`
address that `createPlugin` hands to `bridge/bridgePlugin.ts`; everything else treats them as WAMs. See
`notes/vst-bridge.md`.

## Known limits

- **Composite plugins are live-only.** Some WAMs (Synth-101, for one) build their sound from ordinary Web Audio nodes on
  the main thread and react to MIDI after the audio thread reports it back. An offline render outruns them, so they
  are silent in exports in any host. Plugins whose DSP runs in their AudioWorklet (Spectrum Modal, Soundfont Player,
  the Faust-based Wimmics effects) render fine. The browser says so; a real-time export mode would cover the rest.
- A plugin's state is read back when its window closes, every 3 s while it is open, and before saves and exports.
  An effect plugin in a sleeping (hibernated) container is rebuilt from the last state read. A synth track keeps its
  plugin while it sleeps.
- A wavetable synth holds two 268 KiB table slots per track; switching a table rebuilds it on the audio thread
  (about 1–2 ms).
- The Tone fallback engine (no AudioWorklet: an insecure origin) plays the patch models as oscillator 1 with the amp
  envelope only.
- standardized-audio-context keeps nodes it thinks are passive natively disconnected; a plugin feeding a wrapped node
  would be silent, so every bridge gets a silent constant source (`keepActive` in `plugins/wamHost.ts`).

## Phases

1. Rust instrument engine + analog source, tests; worklet ABI v4.
2. FM and wavetable sources.
3. Frontend models, params, track integration, presets, UI.
4. WAM host, instrument, effect slot, browser, render.
5. Browser test (Playwright), perf check, unit tests, type-check, lint.
