# Audio performance upgrade

Plan for making the JuicyLoops audio stack cheaper to run, in three tiers. Each tier stands on its own and
is only started when the previous one is done and measured.

Paths are relative to `juicyloops/frontend/` unless noted.

## Decisions

| Topic | Decision |
|---|---|
| Always-on dynamics | New racks start neutral: compressor at ratio 1, flat EQ, limiter off. All three are built lazily like the wet effects. The master keeps its limiter on by default. Saved sessions keep their stored values and sound the same. |
| Time-stretch engine | Signalsmith Stretch (MIT, WASM), running in a Web Worker. WSOLA stays as the fallback and reference. |
| Custom DSP toolchain | Rust, compiled to `wasm32-unknown-unknown` in Docker. The synth core is hand-written (the `fundsp` spike in 2.0 ruled it out for now). |
| WASM delivery | Built `.wasm` files are committed. `yarn dsp:build` rebuilds them; CI and Docker check they are up to date. No Rust needed for frontend work. |
| Synth engine (Tier 2) | Free to improve: band-limited oscillators and better envelopes. Existing synth tracks may sound slightly different; mention it in the release notes. |
| Tier 3 | Design only, with a gate. Started only if the Tier 2 measurements hit the limits in "Tier 3 gate". |

## Why this order

Tone.js is a thin layer over native Web Audio nodes: filters, compressors, delays, convolution and oscillators
already run in C++ on the audio thread. The real costs today are:

1. **Graph size.** Every track, container bus and the master builds a compressor (-24 dB, 12:1, so actively
   compressing), a 3-biquad equalizer and a limiter up front (`effects/effects.ts`, `isNeeded`). Every
   `SynthTrack` builds both a `Synth` and a `PolySynth`, and Tone `Signal`s are constant-source nodes that run
   even when silent.
2. **Idle containers still render.** Loop mode plays only `currentContainer`, but every other container's
   tracks, effects and bus stay connected and are processed.
3. **Main-thread DSP.** `timeStretch` (WSOLA) and `detectOnsets` run synchronously on the main thread
   (`tracks/SampleTrack.ts` `render`, `sliceAtHits`). This causes UI jank and can delay Tone's scheduler.
4. **Hot-path allocations.** The step callback runs through Vue proxies (restored tracks are `reactive`), and
   `BaseTrack.parameters` builds a new array on every call. Both `applyAutomation` and `applySongAutomation`
   search these arrays for every lane on every step.
5. **The JS worklet.** `BitCrusher` is a Tone AudioWorklet written in JS, one per instance.

WASM only pays off where we replace many nodes or JS DSP with one worklet (Tier 2), or the whole graph (Tier 3).

---

## Tier 0: Measurement (do first, reuse for every tier)

Nothing ships without numbers from before and after.

- **Benchmark sessions** in `scripts/perf/fixtures/`. Each one is a session file:
  - `small`: 1 container with 8 tracks.
  - `medium`: 4 containers with 8 tracks each, a few wet effects, and song-mode clips on 3 lanes.
  - `heavy`: 8 containers with 16 tracks each, reverb and delay on every bus, plus song automation.
- **`scripts/perf/run.mjs`** (Playwright, Chromium):
  1. Open `/app`, load a fixture and press play.
  2. Poll the CDP `WebAudio.getRealtimeData(contextId)` call for `renderCapacity`, `callbackIntervalMean` and
     `callbackIntervalVariance` over 20 seconds, in loop mode and in song mode.
  3. Record main-thread long tasks (`PerformanceObserver('longtask')`) while a script sweeps the pitch knob of a
     sample track.
  4. Write JSON to `scripts/perf/results/<git-sha>.json` and print a table compared with the previous result.
- **Node counter (dev only).** Patch `ToneAudioNode` construction and disposal behind `import.meta.env.DEV`
  and show the live node count in the Vue devtools or the console. This makes leaks from lazy create and
  dispose visible.
- Record a **baseline** on `main` before any Tier 1 change.

Done when: `yarn perf` prints a baseline table for all three fixtures.

---

## Tier 1: Same stack, less work

Each step is its own commit and its own before/after perf run.

### 1.1 Neutral, lazy dynamics stages

- `effects/definitions.ts`:
  - Compressor `ratio.initial` goes from 12 to 1. The threshold can stay at -24; ratio 1 is neutral.
  - The limiter gets a new `on` parameter (0/1, not automatable, shown as a toggle).
  - Add an `isNeutral(params)` predicate to each definition that has no `wet` control:
    - compressor: `ratio <= 1`
    - equalizer: every band within ±0.05 dB
    - limiter: `on === 0`
- **Rack roles.** Give `Effects` a constructor option `role: 'track' | 'bus' | 'master'`. The role only changes
  initial values: the master starts with `limiter.on = 1`, every other role starts with 0. `MixBus` passes its
  role, and `Sequencer.master` is `'master'`.
- `Effects.isNeeded(effect, params = this.params[effect])`:
  - an effect with `wet` is needed when `wet > 0`, as today;
  - any other effect is needed when `!isNeutral(params)`.
- `applyLive` currently checks non-wet params against the *stored* values. Change it to check the live value
  merged over the stored ones, so automating a neutral compressor's ratio above 1 creates the node. Keep the
  rule that `applyLive` never destroys a node.
- **Migration for saved sessions.** In `Effects.restore`, a snapshot without `limiter.on` counts as
  `limiter.on = 1`, because the limiter was always active before this change. Compressor and EQ values are
  stored in full in old snapshots, so they restore as they were. This covers history, session files and
  duplication, since all three go through `restore` or `copyFrom`.
- **UI.** `EffectPanel.vue` shows the limiter `on` toggle, and the compressor and EQ read as off when neutral.
  Check how the rack lists "active" effects (`isActive`).
- **Render latency** (`render.ts`, `measureLatency`). Today it measures a click through three fresh racks,
  which after this change would contain no compressors. Replace it with:
  - `compressorLatency(sampleRate)`: one click through one native `DynamicsCompressorNode`, cached per sample
    rate;
  - `dynamicsInPath(plan.state)`: the largest number of compressor and limiter nodes on any
    track → bus → master path;
  - latency = the product of the two.
- **Tests.**
  - `effect-definitions.spec.ts`: neutral predicates, role defaults and limiter migration.
  - `render.spec.ts`: `dynamicsInPath`.
  - `session.spec.ts`: an old snapshot (no `limiter.on`) restores with the limiter on.

### 1.2 Step-callback hygiene

- `TrackContainer.play` and `Sequencer.playStep` call `toRaw(track)` before `track.play`, so the audio callback
  never goes through a proxy, and nested `ticks` and `automation` are not wrapped per access.
  (Since the MIDI work, `notes/midi-recording.md`, tracks hold free-timed `notes` instead of one tick per step. The
  step callback reads them from a bucket index, `NotePattern.notesStartingAt(step)`, which is rebuilt only when the
  pattern's `revision` or length changed, so it still allocates and scans nothing; see "Notes instead of ticks" under
  the Results log.)
- `BaseTrack`:
  - Cache `parameters` in a `Map<string, AutomationParam>`, built once per instance. Subclasses' `ownParameters`
    are static.
  - `parameter(key)` becomes a map lookup, and `applyAutomation` stops allocating.
- `MixBus.parameters`: same map. `Sequencer.applySongAutomation` uses `target.parameter(key)` instead of
  `parameters.find`.
- Check the `Draw` step listeners in `useJuicyLoops` and the grid components for per-step reactive writes that
  re-render large lists. The playhead should be a single ref or CSS variable, not a prop on every step cell.
- Tests: existing unit tests plus a quick playback check in the browser. There is no audible behaviour change.

### 1.3 Lazy synth voices

- `SynthTrack` builds only the engine that matches `cutsNotes` (`Synth` for cut, `PolySynth` for overlap).
- `setCutsNotes` builds the other engine on first use and disposes the old one after its release tail
  (`envelope.release` plus a margin), so a note that is still sounding is not cut off.
- `setOscillatorType` and `setEnvelope` apply to whichever engine exists. `oscillatorType` and `envelope` stay
  the source of truth, so a new engine starts with them.

### 1.4 Hibernate idle containers

- **Spike first (half a day).** Measure with the `heavy` fixture whether *disconnecting* an idle container's
  bus from the master lowers `renderCapacity` in Chrome and Firefox. The browser may only render nodes it pulls
  from the destination, or it may render everything.
- **If disconnecting is enough:** add `TrackContainer.sleep()` / `wake()`, which disconnect and reconnect
  `bus.output`.
- **If it is not:** `sleep()` also calls a new `Effects.suspend()` on every track rack and the bus rack. This
  disposes the nodes and keeps the params. `resume()` rebuilds the nodes, and reverb impulse responses rebuild
  asynchronously (`whenReady`).
- **Who sleeps, in loop mode:** every container except `currentContainer`. Switching container wakes the new
  one right away, and the old one sleeps after its tail.
- **Who sleeps, in song mode:** the sequencer looks ahead a wake window (2 bars) with `song.playingAt`. A
  container wakes once a clip starts within the window and sleeps once no clip is due and its tail has passed.
- **Tail length:** the largest of synth `release`, delay feedback time × repeats, reverb `decay`, and 1 second.
  Compute it per container from the stored params, and err on the long side.
- The offline render builds its own sequencer, so it has the same logic. It must `await whenReady()` after
  waking containers before `transport.start`, so every container is awake for the render. The simplest rule:
  never sleep in an offline context.
- **Tests:** a unit test for the wake and sleep schedule computed from a song (pure function in `song.ts` or
  a new `hibernate.ts`), plus a Playwright check that song playback has no gaps at clip starts.

#### Spike results (1.4)

- **Realtime capacity was no use for this.** The machine was busy (load average around 8 on 12 cores, other agents
  running), and the `heavy` loop-mode "load" moved between 2.0 and 2.7 from one 10 s window to the next. That
  happened even with playback *stopped*, so the realtime numbers could not separate the variants.
- **Offline render time instead.** An `OfflineAudioContext` goes through the same graph processing as a realtime
  one, and its wall time is much less noisy. The test: capture `heavy`, rebuild it in a Tone `OfflineContext`
  with a scratch `Sequencer` (loop mode, container 1 playing), change the 7 idle containers, and time only
  `context.render()` for 5 s of audio. Min of 2 rounds, as a fraction of real time:

  | Variant (idle containers) | Chromium 153 | Firefox 155 |
  |---|---|---|
  | all connected | 0.99× | 0.25× |
  | bus output disconnected from the master | 0.87× (-12 %) | 0.24× |
  | + track and bus racks disposed | 0.70× (-29 %) | 0.23× |
  | + synth engines disposed | 0.46× (-54 %) | 0.20× |
  | idle containers removed (lower bound) | 0.36× | 0.21× |

  Round-to-round spread was up to ±40 % (Chromium, round 1 "all connected": 1.71×), but the order held.
  **Chromium keeps processing disconnected subgraphs:** started sources (the synths' oscillators and the Tone
  `Signal` constant sources), LFOs, convolvers and delays still run. Disconnecting alone saves little.
  Firefox renders offline about 4× faster overall, and the differences there are within noise. Firefox has no
  realtime capacity metric (no CDP `WebAudio`), so this is the only signal we have for it.
- **Decision:** `sleep()` disconnects the bus, suspends every track and bus rack (`Effects.suspend()`), and
  disposes the synth engines (`SynthTrack.sleep()`). Sample voices are one-shot and need nothing.

**As built:**

- `hibernate.ts` has the pure parts: `upcomingSegments` (the look-ahead window, wrapped at the song end or the
  loop region), `markDue` (containers with an audible clip in the window; mute and solo work as in `playingAt`),
  `voiceTail` (synth: longest active note + release; sample: region / speed, longer for low notes on an unsliced
  sample), and `Hibernation`. The `Hibernation` class keeps a container awake while it is due. Once it stops
  being due, the class takes its tail: `max(1 s, longest voice + track rack tail) + bus rack tail`, plus 0.5 s.
  After that the container sleeps. A container never due since tracking started sleeps at once.
- `Effects.suspend()/resume()/tail()`. While suspended, values are stored and live automation is ignored. The next
  step's automation puts the live value back after a wake. The delay repeats until -60 dB, which is 4 at Tone's
  fixed 0.125 feedback.
- `MixBus.sleep()/wake()`, `BaseTrack.sleep()/wake()`, `SynthTrack` overrides, and `TrackContainer.sleep()/wake()/tail()`
  with `isAwake`. A track added to a sleeping container sleeps too.
- `Sequencer`:
  - `hibernation` is null when the transport's context is offline. The step callback updates it *before* playing,
    so a container that is due right now (a seek, a clip dropped at the playhead) wakes before its notes are
    scheduled.
  - `setCurrentContainer` and `setMode('loop')` wake the current container right away in loop mode.
  - `seekToStep` in song mode wakes what is due at the target.
  - Per step there are no allocations: a reused `Set` and a 4-number window array. The scan covers the clips once
    (the same work as `playingAt`), and a tail is only computed when a container stops being due.
- **Checked in the app** (Chromium, 240 bpm; A at 0–1 s, B at 5–6 s, both with a 2 s bus reverb; meter on the
  master):
  - A's reverb tail decays fully (-71 dB at 1–2 s, -120 dB at 2–3 s) before A sleeps at 3.7 s.
  - B wakes 2 s ahead (2.98 s). All four B notes are present at -18 to -20 dB, including the first one at the
    clip start and the first one of the second pass.
  - Loop-mode switch: B sounds at once, and A sleeps after its tail (about 3 s later).
  - Tone nodes: 241 with both containers asleep, up to 524 awake. No long tasks.
- **Perf** (`tier1-4-check` vs `baseline`; includes all of 1.1–1.6; machine busy, so absolute numbers are noisy):

  | Mode | load | Nodes |
  |---|---|---|
  | loop | 2.67 → 1.68 | 9 442 → 2 733 |
  | song | 4.31 → 3.46 | 11 032 → 8 079 (4 of 8 containers play at once in `heavy`, plus the window and tails) |
  | sweep | | 0 long tasks (was 5) |
- Side note: while stopped, nothing sleeps or wakes, because there are no steps. Sample tails are long, because a
  voice can play the whole 7 s region. So containers from the song phase stay awake for about 9 s into the next
  loop-mode playback.

### 1.5 Native bitcrusher

- Replace Tone `BitCrusher` with a small `Crusher extends ToneAudioNode` wrapping a `WaveShaperNode`. Its curve
  is a staircase with `2^bits` levels over 65 537 points, rebuilt when `bits` changes; it is not automatable
  sample-accurately (same as today).
- It goes through the same `FACTORIES` entry and the `bits` param keeps its key, so saved sessions are unaffected.
- Check by ear against the old node at 4, 8 and 12 bits.

### 1.6 Stretch and onset detection off the main thread

- New `src/juicyloops/dsp/sampleWorker.ts` (a module worker created with
  `new Worker(new URL(..., import.meta.url), { type: 'module' })`), with messages:
  - `stretch { jobId, channels: Float32Array[], sampleRate, factor }`, which answers with the stretched
    channels;
  - `onsets { jobId, channels, sampleRate, from, to, options }`, which answers with the cut times.
  - All channel data goes across as transferables. Callers send copies (`subarray(...).slice()`), because the
    decoded `AudioBuffer` must stay intact.
- `src/juicyloops/dsp/sampleJobs.ts`:
  - a promise API with one shared worker, created lazily;
  - when `Worker` is undefined (jsdom tests, SSR), it falls back to running inline;
  - stale jobs are dropped by `jobId`.
- `SampleTrack`:
  - `render()` becomes `async`, and a `renderJob` promise replaces the synchronous result.
  - `rendition` is swapped only when the job's `(pitch, speed, region)` still matches the track.
  - `whenReady()` awaits the in-flight job, which the offline render depends on.
  - Until a new rendition arrives, steps play the previous one, as they do during the 150 ms debounce today.
- `sliceAtHits` becomes `async`. Update `SampleSliceTools.vue` to await it and show a busy state.
- **Rendition cache.** Keep an LRU keyed by `(blob identity, region, factor)` in `sampleJobs.ts`, so an export
  (whose offline sequencer re-creates every sample track) reuses renditions instead of stretching again. Cap it
  by total samples, around 50 M floats (about 200 MB).
- **Tests.**
  - `stretch.spec.ts` stays on the pure function.
  - New `sampleJobs.spec.ts` covers the inline fallback, stale job dropping and cache hits.
  - The Playwright pitch-knob sweep in the perf run must show no long tasks over 50 ms from stretching.

### 1.7 Optional: shared reverb impulse responses

`decay` and `preDelay` are already not automatable. Cache generated impulse responses by
`(decay, preDelay, sampleRate)` and share them between racks, so ten identical reverbs render one impulse
response. Only do this if the perf run shows reverb creation as a cost, for example when waking containers
in 1.4.

**Tier 1 done when:** all steps are merged, `yarn check` passes, the Playwright suite passes, and the perf
table shows the gains. Rough expectation: fewer nodes on `heavy` by a large factor and no stretch long tasks.
The real numbers go into this file.

---

## Tier 2: Hybrid WASM (Rust)

Keep Tone for the transport, routing and native effects. Move only work that is node-heavy or runs as JS DSP
into Rust AudioWorklets and a Rust or WASM worker.

### 2.0 Toolchain and repo layout

```
juicyloops/dsp/                     Cargo workspace (repo root level, next to frontend/)
  Cargo.toml
  crates/core/                      no_std + alloc DSP: oscillators, envelopes, voice allocator, smoothing
  crates/synth-worklet/             cdylib with a C ABI, the synth voice engine for an AudioWorklet
  scripts/build.sh                  cargo build --release --target wasm32-unknown-unknown, then wasm-opt -O3
juicyloops/frontend/src/juicyloops/dsp/wasm/*.wasm   committed build output
```

- **No `wasm-bindgen` glue in worklets.** `AudioWorkletGlobalScope` has no `fetch`, and some browsers lack
  `TextDecoder` there. Use plain `#[no_mangle] extern "C"` exports and linear-memory buffers:
  1. The main thread compiles the `.wasm` once (`WebAssembly.compile` on a `?url` import).
  2. It passes the `WebAssembly.Module` to each node in `processorOptions`.
  3. The processor instantiates it synchronously.
- **`fundsp` check (spike, 1 day).** Confirm it builds for `wasm32-unknown-unknown` with `no_std`/`alloc` and
  check its binary size. If it doesn't fit, write the few parts we need by hand in `crates/core`: polyBLEP
  oscillators, ADSR and a one-pole smoother.
- **Build wiring.**
  - Root script `yarn dsp:build` (in `juicyloops/package.json`) runs `dsp/scripts/build.sh`.
  - Commit the `.wasm` files.
  - CI and the Dockerfile rebuild them in a `rust:1-slim` stage and fail if the committed file differs
    (`cmp`). Pin the toolchain in `dsp/rust-toolchain.toml` so builds are reproducible.
- **nginx.** Add `application/wasm` to `gzip_types` and give `*.wasm` a long `Cache-Control`, because the
  filenames are hashed by Vite.

#### Spike results (2.0)

Toolchain, as built (all compilers run in Docker, the host needs only bash and docker):

- `juicyloops/dsp/`: Cargo workspace (edition 2024, `Cargo.lock` committed), `rust-toolchain.toml` pins
  1.98.1 + `wasm32-unknown-unknown`. `crates/core` (no_std + alloc: polyBLEP/polyBLAMP oscillator, ADSR with
  linear attack and exponential decay/release, one-pole smoother, 11 unit tests). `crates/synth-worklet`
  (cdylib placeholder: `abi_version`, `init`, `out_ptr`, `set_test_tone`, `process`; no_std with a bump
  allocator, zero imports, 7.7 KB).
- Image `docker/rust.Dockerfile`: `rust:1.98.1-slim-bookworm` pinned by digest + binaryen `version_133`
  (sha256-checked download). The C++ build uses `emscripten/emsdk:6.0.10` pinned by digest.
- `yarn dsp:build` / `dsp:check` / `dsp:test` (root `package.json`) run `dsp/scripts/build.sh`, `check.sh`,
  `test.sh`. Containers run as the host user; the cargo cache is `dsp/.cargo-home`, the target dir
  `dsp/target` (both gitignored). The repo is always mounted at `/src/dsp` so embedded paths never differ.
- Builds are deterministic: a clean rebuild (`rm -rf dsp/target`) is byte-identical, which `check.sh`
  verifies with `cmp` against the committed files.
- `wasm-opt` flags list the wasm features explicitly (rustc's default "generic" CPU: bulk-memory,
  nontrapping-fptoint, sign-ext, mutable-globals, multivalue, reference-types; all in Safari 15+), because
  rustc no longer emits a `target_features` section for binaryen to detect.

**fundsp: not used. The core is hand-written.**

- `fundsp` 0.23.0 (latest release) does **not** compile with `default-features = false`: `resample.rs` uses
  `Vec`/`vec!` without importing them from `alloc`. Upstream master (5595840, 2026-03) fixes that file but
  breaks in `oversample.rs` and `realseq.rs`. no_std is not tested upstream.
- With the one-line import fix applied locally, a saw × `adsr_live` graph costs (after `wasm-opt -O3`):
  static graph 8.8 KB (5.0 KB gz), as a dynamic `Net` 24.2 KB (10.8 KB gz). With `features = ["std"]`
  (builds unpatched) it is 53.9 KB (23.7 KB gz). The hand-written equivalent is 7.7 KB (4.3 KB gz). Speed
  in Node for 100 s of one voice: hand-written 23-30 ms, fundsp 32-41 ms.
- Size would be acceptable, but fundsp's `adsr_live` does not fit the "better envelopes" goal: linear
  segments computed from a closure every ~2 ms, retrigger restarts from 0 (click), and it only attacks after
  it has seen the gate low first. Blocks are capped at 64 frames (`MAX_BUFFER_SIZE`), so a 128-frame quantum
  needs two calls. Voice pooling and stealing are ours to write either way.
- Revisit fundsp for 2.3 (effects), where its filters and graph combinators pay off, using the `std` feature
  (works today) or a released no_std fix.

### 2.1 Signalsmith Stretch in the sample worker

- **Spike.** Check what the `signalsmith-stretch` npm package offers. It is mainly an AudioWorklet node; we need
  offline, whole-buffer processing.
  - Preferred: use its WASM module directly inside `sampleWorker.ts`, if the package exposes a buffer API.
  - Fallback: compile the header-only C++ library ourselves with Emscripten into a second committed `.wasm`.
    This is the one C++ exception to the Rust choice, because the library is C++, and it is a build-once
    artifact.
- Put it behind the existing `stretch` message from 1.6. WSOLA stays in the codebase as the fallback when
  the WASM fails to load, and as the reference in `stretch.spec.ts`.
- Pitch path: Signalsmith can shift pitch directly without playing the result at a different rate. Check
  whether that sounds better than "stretch, then play at the pitch ratio". If it does, the rendition plays at
  rate 1 and `SampleTrack.trigger` changes accordingly. Per-note semitones for unsliced samples still use
  `playbackRate`.
- Compare A/B by ear with drums, a vocal and a bass at ±7 semitones and 0.5× / 2× speed.

#### Spike results (2.1)

- **npm `signalsmith-stretch` 1.3.2 (MIT)**: AudioWorklet only. The WASM is inlined in Emscripten glue and
  driven by an `AudioWorkletProcessor`; the public API is a `StretchNode` with `schedule`/`addBuffers`/
  `start`. There is no whole-buffer API usable in a Worker, so we compile the library ourselves (fallback
  path).
- **Upstream C++** (github.com/Signalsmith-Audio/signalsmith-stretch, tag 1.4.0 = a670068, MIT) is header
  only and depends on Signalsmith Linear 0.6.4 (MIT). Both are vendored under `dsp/stretch/vendor/` (3 headers
  + licenses, versions in `vendor/VERSIONS`, refresh with `dsp/stretch/vendor.sh`). It has
  `exact(inputs, inLen, outputs, outLen)` for a complete buffer (output aligned to input, no pre-roll) and
  `setTransposeSemitones(semitones, tonalityLimit)` for pitch shift independent of the stretch ratio.
- **Our build**: `dsp/stretch/stretch.cpp` exports `sj_alloc(floats)`, `sj_free(ptr)`,
  `sj_stretch(in, channels, inLen, outLen, sampleRate, semitones, tonalityHz) -> out` (planar buffers;
  0 on failure) and `sj_abi_version`. Built with `-sSTANDALONE_WASM --no-entry -DNDEBUG` into
  `frontend/src/juicyloops/dsp/wasm/stretch.wasm`, 65 KB, no JS glue. Its only import is
  `env.emscripten_notify_memory_growth` (stub `() => {}`); call the exported `_initialize()` once after
  instantiating. Views on `memory.buffer` must be re-created after each call, because memory can grow.
  Seeded RNG (`SignalsmithStretch(seed)`), so the output is deterministic and no WASI random import is needed.
  Inputs shorter than one seek length (about 0.1 s, drum hits) are zero-padded inside `sj_stretch`, then
  trimmed.
- **Verified in Node 24** (440 Hz sine, 48 kHz, stereo): 2× longer, 0.5×, +7 st at 1×, -7 st at 1.5× and a
  30 ms one-shot at 2× all give the exact output length, frequency within 0.1 % of the expected value and RMS
  within 2 % of the input. A burst at 0.5 s lands at 0.998 s after a 2× stretch. 10 s stereo → 12.5 s at +3 st
  takes about 300 ms (memory 10.5 MB). `-msimd128` gave at most ~10 % and a larger file, so the build stays
  scalar.
- Next (2.1 proper): load it in `sampleWorker.ts` with `WebAssembly.instantiate` on a `?url` import, keep
  WSOLA as the fallback, and do the A/B listening test for the pitch path.

#### Implementation (2.1)

- `src/juicyloops/dsp/signalsmith.ts` wraps the module (no imports, so Node scripts can load it too):
  `loadSignalsmith(url)` (streaming when served as `application/wasm`), `instantiateSignalsmith(bytes)`, and
  `stretch(channels, sampleRate, factor, semitones = 0)` with the same output length rule as `timeStretch`
  (`round(length × factor)`, factor 1 returns copies). It checks `sj_abi_version() === 1`.
- `sampleWorker.ts` imports `./wasm/stretch.wasm?url` and loads the module on the first `stretch` job. If it
  cannot load, it warns once and every job uses WSOLA. `answerSampleRequest(request, engine)` takes the engine;
  a job that throws inside Signalsmith (out of memory) is redone with WSOLA. Inline (no `Worker`, i.e. the jsdom
  tests) it is always WSOLA. The protocol, the cache key and `SampleTrack` did not change.
- Vite emits the module as a hashed asset (`assets/stretch-<hash>.wasm`, 65 KB, 27 KB gzip) next to the worker
  chunk. nginx: `application/wasm` in `gzip_types` (prod and dev) and `.wasm` in the long-cache location of the
  prod conf. The `nginx:latest` `mime.types` already maps `.wasm` to `application/wasm`.
- Tests: `__tests__/signalsmith.spec.ts` loads the committed `.wasm` from disk (length rule, pitch, level,
  short one-shots, determinism, and the WSOLA fallback through the protocol).

**Pitch path: stays "stretch by the pitch ratio, then play at that rate" (A).** Signalsmith's own transposition
(B) was measured against it with a throwaway Node script, Signalsmith doing the stretch in both (48 kHz):

| Check | A: stretch, then `playbackRate` | B: direct transpose |
|---|---|---|
| Pure tone pitch error, 440 Hz, ±3…±12 st, 0.5×–2× | 0.00 cents | 0 to 7 cents |
| Pure tone, 220 Hz | 0.00 cents | up to +16 cents (-7 st) |
| Pure tone, 110 Hz | 0.00 cents | up to +22 cents (-3 st) |
| Pure tone, 55 Hz (bass) | 0.00 cents | +21 to +79 cents |
| Harmonic tone (220 Hz + 7 harmonics), harmonic-to-noise | 40–53 dB (26 dB at +7 st / 0.5×) | 39–46 dB |
| Drum hits, 10–90 % attack at ±7/±12 st, 1× (at +7 st / 0.5×) | 5.5–10.7 ms (25 ms) | 4.8–6.3 ms (13 ms) |
| Drum hits, onset position error | 3–15 ms | 3.5–9 ms |

The rate change keeps the pitch exact by construction; the frequency-domain transposition is coarse at low
frequencies, so bass and low vocals come out audibly sharp. B only wins on drum attacks (a few ms, more when slowed down), which the listening test should weigh. So
`SampleTrack` keeps playing the rendition at `semitoneRatio(rendition.pitch + voice.semitones)`; the choice is
recorded in `dsp/sampleProtocol.ts` and `SampleTrack.stretchFactor`.

**A/B by ear.** From `juicyloops/frontend`:

```
node scripts/perf/stretch-ab.mjs drums.wav vocal.wav bass.wav
node scripts/perf/stretch-ab.mjs bass.wav --settings "+7st,-7st,0.5x,2x,-7st@2x" --out /tmp/ab
```

For every file and setting it writes `scripts/perf/stretch-ab-out/<name>_<variant>_<setting>.wav` (gitignored)
plus `<name>_original.wav`. Variants: `wsola` (the fallback, as the app plays it), `signalsmith` (what the app
plays now), `transpose` (Signalsmith's direct transposition, B above). Default settings `+7st,-7st,0.5x,2x`;
speed as in the app (2x = twice as fast). Without files it writes three synthetic demos (drums, a 55 Hz bass
line, a harmonic tone). Inputs: PCM 8/16/24/32-bit or float WAV. Needs Node 22.18+ (loads the `.ts` sources
directly).

**Speed.** 10 s stereo, 44.1 kHz, in the worker (built app, `vite preview`, Chromium headless, WSL2 with other
jobs running): Signalsmith 325 ms at ×1.26 (+4 st), 130 ms at ×0.5, 580 ms at ×2; the first job adds about
120 ms for loading the module. WSOLA on the same machine: 90–280 ms. Signalsmith is 2–5× slower, but it runs
off the main thread: the pitch sweep in the dev app shows no long tasks, and a new rendition arrives about
0.3–0.6 s after the knob rests instead of 0.1–0.3 s.

**Verified in the app** (dev server, Chromium): a 440 Hz sine sample plays at 659.25 Hz at +7 st (expected
659.26), 293.67 Hz at -7 st, live and offline (`renderSession`: exact at +7, -7, +12, -5). Speed 0.5×/2×
gives the expected sounding length; a marker at 0.5 s lands at 1.003 s (0.5×) and 0.247 s (2×; 0.241 s at 2× and -7 st). Sliced
samples still start on the slice's hit within 0.3–1.3 ms at 0 / ±7 st and 0.5× / 2×.

### 2.2 Rust synth voice engine

One `AudioWorkletNode` per `SynthTrack`, replacing `Synth` and `PolySynth`. All voices of a track are summed
inside one node.

- **Engine (`crates/synth-worklet`).**
  - Band-limited sine, square, triangle and saw oscillators (polyBLEP, or wavetables if polyBLEP aliasing is
    audible above C7).
  - An ADSR with exponential decay and release. This is the "free to improve" part.
  - A voice pool of 16 with oldest-first stealing and a mono mode for `cutsNotes` (legato retrigger, one
    voice).
  - Per-voice velocity and parameter smoothing to avoid zipper noise.
- **C ABI.** `init(sampleRate)`, `note_on(frame, freq, velocity, duration_frames)`, `set_param(frame, id, value)`,
  `set_mode(mono)`, `process(out_ptr, frames)`. Events are queued with their frame offset, so timing is
  sample-accurate within the 128-frame quantum.
- **Processor (`src/juicyloops/dsp/synthProcessor.ts`).** Loaded with `context.addAudioWorkletModule`. It
  receives events over `port` and converts `time` to a frame with `currentFrame`. The look-ahead is 0.2 s, so
  events always arrive ahead of time.
- **`SynthVoices` wrapper (`src/juicyloops/dsp/SynthVoices.ts`).**
  - A `ToneAudioNode` that owns the worklet node, so `connect`, `dispose` and the `Effects` wiring stay
    unchanged.
  - `triggerAttackRelease(note, duration, time, velocity)` converts the note to a frequency with Tone's
    `Frequency` and the duration to seconds with the transport, then posts the event.
  - `setEnvelope(param, value, time)` posts a timed `set_param`. `setOscillatorType` posts an immediate one.
- **`SynthTrack`** swaps both Tone engines for one `SynthVoices`. The 1.3 lazy-voice code goes away.
  `cutsNotes` maps to `set_mode`.
- **Offline render.** Register the worklet module on the offline context before `sequencer.restore`. Pass the
  compiled `WebAssembly.Module` from the main thread; it is structured-cloneable. `Sequencer.whenReady`
  awaits the module promise.
- **Tests.**
  - `cargo test` in `crates/core`: oscillator frequency and level, envelope timing, voice stealing and mono
    retrigger.
  - Vitest: `SynthVoices` event conversion with a stubbed port.
  - Playwright: render a known pattern offline and check the peak, RMS and onset positions against stored
    expectations.
- **Rollout.** Ship behind a dev flag (`PUBLIC_RUST_SYNTH`) for one round of listening, then make it the default
  and delete the Tone synth path.

**As built (2.2):**

- **Rollout, as decided:** the Rust engine is the **default**. `PUBLIC_RUST_SYNTH=false` (build time) selects the Tone.js
  engine for one release; after that, delete `ToneSynthEngine` in `tracks/synthEngine.ts` and the flag. The Tone engine is
  also the automatic fallback where AudioWorklet is missing (an insecure origin, e.g. the plain-http dev host
  `http://juicyloops.test` without `--unsafely-treat-insecure-origin-as-secure`) or when the module or processor fails
  (warned once; every track then rebuilds on Tone). Release note: synth tracks sound slightly different (below).
- **Engine** (`dsp/crates/core/src/synth.rs`, `Synth`): 16 voices of polyBLEP oscillator × ADSR × velocity, summed mono.
  Poly: a free voice, else the oldest *released* voice, else the oldest. Mono (`cutsNotes`): the latest sounding voice
  is retriggered legato (attack from the current level, pitch jump with continuous phase) and the new note owns the
  release time; any other sounding voice is released. Velocity glides 3 ms on a taken-over voice; the sustain level
  glides 5 ms (per sample, shared by all voices). Attack/decay/release changes apply to sounding voices at once. Events
  (`note_on`, `set_param`) carry absolute frames, wait in a fixed 256-slot queue and apply on exactly their frame (the
  block is split there); late events apply at the block start, a note that arrives after its own end is dropped.
  No allocation after `init`. `OnePole` now snaps onto its target (f32 rounding stalled it a few ulps short), `Adsr`
  gained a cheap `set_sustain`.
- **C ABI v2** (`crates/synth-worklet`, 14.9 KB, 7.5 KB gzip, no imports): `abi_version() = 2`, `init(sampleRate)`,
  `out_ptr()`, `note_on(frame: f64, hz, velocity, duration_frames: f64) -> 1|0`, `set_param(frame: f64, id, value) -> 1|0`
  (0 waveform, 1 attack, 2 decay, 3 sustain, 4 release), `set_mode(mono)`, `process(start_frame: f64, frames) -> busy`.
  Frames are whole numbers in f64 so JS needs no BigInt. `process` renders into the out buffer and returns sounding
  voices + queued events; 0 means silent until the next event. The placeholder `set_test_tone` is gone.
- **Processor** (`src/juicyloops/dsp/synthProcessor.ts`): instantiates the `WebAssembly.Module` from `processorOptions`
  synchronously, converts message times to frames (`round(time × sampleRate)`), and passes `currentFrame` to
  `process`. While the engine reports silence and no message came in, a block costs one `fill(0)` and no wasm call.
  It returns `true` while the node lives (with no inputs, `false` would silence it for good) and `false` after a
  `dispose` message, so a disposed node is not kept running.
  - Vite: `import url from './synthProcessor.ts?worker&url'`. The build emits it as a 1 KB IIFE asset
    (`assets/synthProcessor-<hash>.js`), the wasm as `assets/synth-worklet-<hash>.wasm`; the SSR build is unaffected.
  - **Trap:** standardized-audio-context fetches the module source and wraps it in a function before registering it,
    so the file may contain no `import`/`export` statement at all. Even `import type` breaks the dev server: its TS
    transform turns an elided import into `export {}`. Types come in as `import('./synthProtocol').X` expressions.
- **Protocol** (`dsp/synthProtocol.ts`): message types, param ids, `SYNTH_ABI`, and `SynthEvents`, which turns
  notes/params into messages and holds them until the node exists.
- **`SynthVoices`** (`dsp/SynthVoices.ts`, a `ToneAudioNode`): compiles the module once per page
  (`compileStreaming` when served as `application/wasm`), registers the processor once per context (`addAudioWorkletModule`,
  including each offline render's), and builds the node (0 inputs, 1 mono output into a native `GainNode`). A woken
  track finds both ready and builds its node synchronously. Notes go through `noteFrequency` (Tone's `FrequencyClass`,
  cached) and `toSeconds` on the node's own context, so an offline render uses its own tempo. `whenReady()` resolves once
  the node exists; `SynthTrack.whenReady` returns it, so `Sequencer.whenReady` covers the offline render.
- **`SynthTrack`** keeps one `SynthEngine` (`tracks/synthEngine.ts`: `createSynthEngine` picks `SynthVoices` or
  `ToneSynthEngine`, which holds the 1.3 lazy Synth/PolySynth code). `cutsNotes` → `set_mode`, envelope automation →
  timed `set_param` (sample-accurate instead of `atTime`'s `setTimeout`), oscillator type → immediate `set_param`.
  `sleep()` disposes the engine, `wake()` rebuilds it with the stored mode, oscillator and envelope.
- **Sound changes vs Tone** (for the release notes): band-limited polyBLEP square/saw/triangle instead of Web Audio's
  wavetables (levels matched: square and saw are scaled by 0.85 like Web Audio's peak-normalized ones, measured RMS within
  1 %), exponential decay and release that end in the set time (Tone's approach curves), legato retrigger in cut mode
  where a new note's release is its own (Tone's `Synth` could release a following note early at the previous note's
  end), sustain changes reach held notes (smoothed), and notes start on their exact frame (Tone's were 64–66 frames late
  offline in Chromium).
- **Also fixed on the way:**
  - The Tone warning "Schedulable methods should include the provided time argument" came from hibernation: waking
    and sleeping build and dispose nodes inside the transport's step callback (first seen: `OmniOscillator.dispose` of a
    sleeping synth; after the swap `CrossFade.dispose` in `Effects.suspend`, then `Phaser`'s own constructor starting its
    LFO). `Sequencer.playStep` now wraps `hibernation.update` in Tone's `debug.enterScheduledCallback(false/true)`
    (exported, marked internal); nothing there is meant to be timed. No warnings on `heavy` any more.
  - `compressorLatency` measured with a single-sample click, which Firefox's compressor swallows entirely, so Firefox
    exports were not compensated (every note 288 frames = 6 ms late). A 10 ms burst measures 288 frames in both.
- **Tests.** `cargo test`: 27 in core (13 new in `synth`: 440 Hz and level, onset frame and ramp, late and expired
  events, velocity, release timing, overlap, oldest-first stealing, stealing a released voice first, mono legato
  retrigger without a jump and with its own release, switching to mono, timed params with a gliding sustain,
  waveform level, bad input and a full queue, same-frame order; plus the smoother snap) and the ABI round trip in the
  worklet crate. Vitest `synthVoices.spec.ts` (13): `SynthEvents` with a stubbed port (conversion, ids, holding until
  attached, dispose) and the processor itself on the committed `.wasm` with stubbed worklet globals (registration
  name, ABI check, silence, A4 onset/pitch/ramp, timed params, mono vs poly, `process` returning false after dispose).
- **Verified** (Chromium 153 headless, dev server and `vite build` + `vite preview`; Firefox for the offline checks):
  - Offline (`renderSession`, 48 kHz, 120 bpm): A4 sine sounds at 440.00 Hz, first non-zero sample on the note's frame
    + 1 (every oscillator starts at phase 0, a zero crossing), then a linear ramp (0.034 peak over the first 24 samples);
    notes on steps 0/8/16/24 start at frames 1, 48001, 96001, 144001, 192001 in Chromium and in Firefox. Oscillator
    switch (RMS sine 0.075 / square 0.089 / triangle 0.061 / saw 0.051, Tone 0.075 / 0.090 / 0.061 / 0.052; all 440 Hz), attack automation (a
    2 s attack from step 4: 0.016 peak in its first 50 ms vs 0.34), cut vs overlap (A4 then E5 over it: cut 0.001/0.354,
    overlap 0.354/0.354 by Goertzel). Level matches the Tone engine (peak 0.352 vs 0.350, RMS 0.084 vs 0.085).
  - Live: A4 at 440.00 Hz, E5 at 659.25 Hz after its container woke; a container switch in loop mode wakes the new one
    and the old one's engine is disposed after its tail (`SynthVoices` count 2 → 1).
  - Built app under `vite preview`: `synth-worklet-<hash>.wasm` served as `application/wasm`, processor loaded, a dropped
    session plays A4 at 440.00 Hz; WAV export from the dialog starts on frame 1 at 440.00 Hz, not silent.
- **Perf** (`tier2-2` vs `tier1`, quiet machine; rows in the Results log): `heavy` loop now renders in real time (load
  1.63 → 0.83, callbacks back at 10.0 ms from 16.4 ms), `heavy` song 3.53 → 2.59 (callback interval 35 → 26 ms), the
  sweep phase 4.27 → 2.46. Nodes -27 % (heavy loop) to -70 % (medium song). `small`/`medium` loop capacity -6 to -11 %.
  `heavy` song is still over budget, but that is not the synths any more (next table).
- **Node classes, `heavy`, after 20 s of song mode** (dev node counter; loop mode in brackets):

  | Class | Tier 1 | 2.2 |
  |---|---|---|
  | total | 8 085 (2 733) | 3 979 (1 986) |
  | Gain | 3 108 | 1 635 |
  | ToneConstantSource / Signal | 1 008 / 890 | 248 / 130 |
  | Volume | 857 | 369 |
  | ToneBufferSource (sample voices) | 323 | 334 |
  | Synth / OmniOscillator / AmplitudeEnvelope / Oscillator / ToneOscillatorNode / PolySynth | 152 / 152 / 152 / 176 / 108 / 32 | 0 / 0 / 0 / 24 / 24 / 0 |
  | SynthVoices | - | 88 |
  | PanVol / Panner (one per track and bus) | 137 / 137 | 137 / 137 |
  | Noise / Merge / ListenerInstance / DestinationInstance / TickSignal | 138 / 89 / 70 / 70 / 70 | 138 / 89 / 70 / 70 / 70 |
  | WaveShaper / CrossFade / GainToAudio / Delay | 72 / 46 / 46 / 40 | 72 / 46 / 46 / 40 |
  | LFO effects' parts (LFO, Zero, AudioToGain, Scale, Multiply, Add, FeedbackDelay) | 24 each | 24 each |

  What is left, for the 2.3 decision: mixer plumbing (a `Gain` input per track, `PanVol` = `Volume` + `Panner` per track
  and bus) and sample voices make up most of it. The LFO effects (8 choruses and 4 phasers in `heavy`) are about 200
  nodes, all other wet effects (CrossFade + dry/wet gains, delays, reverbs) a few hundred more. About 500 of the counted
  nodes are not in the audio graph at all: Tone's `Reverb.generate` renders every impulse response in a new
  `OfflineContext` (2 `Noise`, `Merge`, `Gain`, plus that context's Listener/Destination/Transport) and never disposes
  it; there were 69 such renders after the song phase, one per reverb (re)build on wake. They are garbage once rendered
  but the counter keeps them. **Recommendation:** skip 2.3 for now (Rust effects would replace a few hundred nodes of
  about 3 500); do 1.7 (shared impulse responses) if reverb rebuilds on wake show up, and look at the per-track
  `Gain` + `PanVol` stage if the node count still matters.

### 2.3 Optional: Rust effects

Only if the Tier 2 perf run still shows JS or Tone overhead in effects. Candidates are the `Crusher` from 1.5
(adding sample-rate reduction) and the LFO effects (chorus, phaser, tremolo, vibrato, auto-filter), which in
Tone are several nodes each and could be one worklet per rack. Not planned in detail.

**Tier 2 done when:** the synth and stretch paths run on WASM, `yarn check`, `cargo test` and Playwright pass,
the up-to-date check for the committed `.wasm` passes in CI and Docker, and the perf table is recorded here.

---

## Tier 3: Single-worklet engine (gated design)

### Gate: start only if one of these holds after Tier 2

- `heavy` fixture `renderCapacity` > 0.6 on a mid-range laptop, or audible dropouts on any fixture.
- A product need the node graph cannot meet: more than 64 tracks, sample-accurate modulation of effect
  params, per-voice effects, or deterministic offline renders that match playback bit for bit.

### Architecture

- **One `AudioWorkletNode` (stereo out) runs the whole mix in Rust:** tracks, container buses, master, all
  effects, sample playback and automation. The Tone transport and `Sequencer.playStep` scheduling are replaced
  by an engine clock inside the worklet, so notes are sample-accurate and main-thread jank can no longer delay
  scheduling.
- **Main thread ↔ engine.**
  - Commands (pattern edits, parameter changes, transport) go through a lock-free SPSC ring buffer in a
    `SharedArrayBuffer`.
  - Engine → UI (playhead step, meters) uses a second ring buffer read on `requestAnimationFrame`.
  - `port.postMessage` is the fallback when the page is not cross-origin isolated.
- **Session model.** The existing TS classes (`BaseTrack`, `Song`, and so on) stay the source of truth for
  editing, history and save/load. A thin "engine sync" layer diffs state changes into commands, so the Vue side
  and `useJuicyLoops` do not change shape.
- **Samples.** Decoded channel data is copied into engine memory once per sample. Stretching stays in the
  worker (2.1) and its results are sent as new sample data.
- **Offline export.** The same engine runs in a Worker without an AudioContext and is driven as fast as it
  can process blocks. This replaces `Offline()` and makes exports faster than today.
- **Effects.** Port each Tone effect to Rust (reverb as an algorithmic FDN or a partitioned convolution;
  compressor and limiter with explicit lookahead so latency is known and compensated). Sessions keep their
  param keys, so saved files load unchanged, but the sound changes and needs listening tests.

### Cross-origin isolation (needed for SharedArrayBuffer)

The studio is served under `/app` in `dev/nginx/production.juicyloops.daspete.test.conf`. Add
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` only in
`location /app`, so the marketing pages and their embeds are not affected. Everything the studio loads
(fonts are self-hosted, samples are blobs) must be same-origin or carry CORP headers. Audit before enabling.

### Migration outline (only if the gate is met)

1. Build the engine crate with tracks, buses, synth and sampler, no effects yet, behind `PUBLIC_ENGINE=wasm`.
2. Engine sync layer plus ring buffers, with the Vue app unchanged.
3. Port the effects one at a time. Until an effect exists in the engine, a session that uses it plays on the
   old engine (a per-session fallback).
4. Worker-based offline export.
5. Cross-origin isolation in nginx.
6. Remove Tone once no fallback path is used.

Estimated size: several weeks. Re-estimate from the Tier 2 measurements before committing.

---

## Results log

| Date | Commit | Fixture | Mode | renderCapacity | Nodes | Long tasks > 50 ms (pitch sweep) |
|---|---|---|---|---|---|---|
| 2026-09-28 | `ed3bcb1` (baseline) | small | loop | 0.855 mean, 0.974 max (load 0.86) | 403 idle, 607 playing | 10, max 124 ms, 739 ms total |
| 2026-09-28 | `ed3bcb1` (baseline) | small | song | 0.829 mean, 0.978 max (load 0.83) | 611 playing | |
| 2026-09-28 | `ed3bcb1` (baseline) | medium | loop | 0.798 mean, 0.998 max (load 0.80) | 1 800 idle, 2 008 playing | 4, max 130 ms, 351 ms total |
| 2026-09-28 | `ed3bcb1` (baseline) | medium | song | 0.944 mean, 0.998 max (load 1.06) | 2 802 playing | |
| 2026-09-28 | `ed3bcb1` (baseline) | heavy | loop | 0.994 mean, 0.996 max (load 2.67) | 8 884 idle, 9 442 playing | 5, max 150 ms, 484 ms total |
| 2026-09-28 | `ed3bcb1` (baseline) | heavy | song | 0.997 mean, 0.998 max (load 4.31) | 11 032 playing | |
| 2026-09-28 | `tier1-4-check` (1.1–1.6 + 1.4, dirty) | heavy | loop | 0.997 mean, 0.999 max (load 1.68) | 5463 idle, 2733 playing | 0, max 0 ms |
| 2026-09-28 | `tier1-4-check` (1.1–1.6 + 1.4, dirty) | heavy | song | 0.999 mean, 0.999 max (load 3.46) | 8079 playing | |
| 2026-09-28 | `tier1` (all of Tier 1, quiet machine) | small | loop | 0.868 mean, 0.965 max (load 0.87) | 404 playing | 1, max 66 ms |
| 2026-09-28 | `tier1` | small | song | 0.886 mean, 0.965 max (load 0.89) | 404 playing | |
| 2026-09-28 | `tier1` | medium | loop | 0.850 mean, 0.976 max (load 0.85) | 648 playing | 0 |
| 2026-09-28 | `tier1` | medium | song | 0.816 mean, 0.998 max (load 0.83) | 1933 playing | |
| 2026-09-28 | `tier1` | heavy | loop | 0.997 mean, 0.999 max (load 1.63) | 2735 playing | 6, max 61 ms (UI, not stretching) |
| 2026-09-28 | `tier1` | heavy | song | 0.999 mean, 0.999 max (load 3.53) | 8077 playing | |
| 2026-09-28 | `tier2-2` (2.1 + 2.2 Rust synth, dirty) | small | loop | 0.772 mean, 0.907 max (load 0.77) | 127 playing | 0 |
| 2026-09-28 | `tier2-2` | small | song | 0.793 mean, 0.933 max (load 0.79) | 127 playing | |
| 2026-09-28 | `tier2-2` | medium | loop | 0.802 mean, 0.928 max (load 0.80) | 371 playing | 0 |
| 2026-09-28 | `tier2-2` | medium | song | 0.813 mean, 0.961 max (load 0.81) | 587 playing | |
| 2026-09-28 | `tier2-2` | heavy | loop | 0.827 mean, 0.982 max (load 0.83) | 1988 playing | 2, max 52 ms |
| 2026-09-28 | `tier2-2` | heavy | song | 0.992 mean, 0.997 max (load 2.59) | 3995 playing | |
| 2026-09-28 | `ticks-7315b50` (tick patterns, before notes; step timing added) | small | loop | 0.819 mean, 0.903 max (load 0.82) | 123 playing | 0 |
| 2026-09-28 | `ticks-7315b50` | small | song | 0.782 mean, 0.911 max (load 0.78) | 123 playing | |
| 2026-09-28 | `ticks-7315b50` | medium | loop | 0.818 mean, 0.925 max (load 0.82) | 369 playing | 0 |
| 2026-09-28 | `ticks-7315b50` | medium | song | 0.838 mean, 0.960 max (load 0.84) | 583 playing | |
| 2026-09-28 | `ticks-7315b50` | heavy | loop | 0.815 mean, 0.976 max (load 0.82) | 1996 playing | 0 |
| 2026-09-28 | `ticks-7315b50` | heavy | song | 0.992 mean, 0.996 max (load 2.09) | 3971 playing | |
| 2026-09-28 | `midi` (notes + MIDI phases 1-4, 'interactive', the new default) | small | loop | 0.820 mean, 0.914 max (load 0.82) | 123 playing | 0 |
| 2026-09-28 | `midi` | small | song | 0.796 mean, 0.907 max (load 0.80) | 123 playing | |
| 2026-09-28 | `midi` | medium | loop | 0.835 mean, 0.929 max (load 0.84) | 367 playing | 0 |
| 2026-09-28 | `midi` | medium | song | 0.793 mean, 0.960 max (load 0.79) | 587 playing | |
| 2026-09-28 | `midi` | heavy | loop | 0.826 mean, 0.975 max (load 0.83) | 1988 playing | 0 |
| 2026-09-28 | `midi` | heavy | song | 0.994 mean, 0.997 max (load 2.14) | 3995 playing | |
| 2026-09-28 | `midi-balanced` (same, `--latency balanced`) | small | loop | 0.820 mean, 0.904 max (load 0.82) | 123 playing | 0 |
| 2026-09-28 | `midi-balanced` | small | song | 0.833 mean, 0.910 max (load 0.83) | 123 playing | |
| 2026-09-28 | `midi-balanced` | medium | loop | 0.781 mean, 0.925 max (load 0.78) | 367 playing | 0 |
| 2026-09-28 | `midi-balanced` | medium | song | 0.810 mean, 0.966 max (load 0.81) | 579 playing | |
| 2026-09-28 | `midi-balanced` | heavy | loop | 0.784 mean, 0.972 max (load 0.79) | 1996 playing | 0 |
| 2026-09-28 | `midi-balanced` | heavy | song | 0.993 mean, 0.996 max (load 2.11) | 4011 playing | |

How to read it (full numbers in `scripts/perf/results/baseline.json`; `yarn perf <label> --compare scripts/perf/results/baseline.json`
diffs a later run against it):

- Measured with `yarn perf` against the dev server (the node counter is dev-only), Chromium 153 in headless mode
  (`channel: 'chromium'`), under WSL2. The headless audio device calls back every 441 frames (10 ms at 44.1 kHz);
  even Tone's idle default context (see below) shows about 0.2 there, so read the numbers relative to each
  other, not as absolute headroom.
- **renderCapacity saturates at 1.** Past that, Chrome simply calls back late: on `heavy` the callback interval
  grows from 10 ms to 27 ms (loop) and 43 ms (song). The **load** column is renderCapacity scaled by how late the
  callbacks come (1 = exactly real time), so gains stay visible while a fixture is still over budget. Today
  `heavy` renders about 2.7× (loop) to 4.3× (song) slower than real time on this machine, `medium` song is just
  over.
- **Nodes** are live Tone `ToneAudioNode`s (constructed minus disposed; `window.__jlNodeCount` in dev). "Idle" is
  right after the session loaded, "playing" at the end of a 20 s playback phase (voices and sources included).
- **Long tasks** are from the pitch sweep only: six drags of one-semitone steps 30 ms apart, each followed by a
  400 ms rest so the debounced `timeStretch` runs, on the first sample track of container 1 (a 7 s stereo drum loop)
  while it plays in loop mode. Long tasks during plain playback are in the JSON; they are noisy run to run (0 to
  about 20) and mostly UI work.
- **Latency hint and step timing** (added to the harness for the MIDI work): `--latency interactive|balanced` sets the
  app's "low latency" setting (`localStorage['juicyloops:lowLatency']`) before the page loads. Without it the app's
  default applies: 'interactive' since the MIDI work, 'balanced' in every run up to `tier2-2`/`phase1`. The JSON also
  records the context's hint and latencies (`audioContext`) and, per phase, the main-thread time of the sequencer's
  step callback (`stepCallback`: count, mean, p95, max ms; the harness wraps `Sequencer.playStep` in the page;
  `performance.now()` is coarsened to 0.1 ms, so read means, not single calls).
- Side finding: Tone creates its own default `AudioContext` ('interactive') on import, before `engine.ts` installs
  its own ('balanced' then; 'interactive' by default since the MIDI work). It kept running idle next to the engine's context; since step 1.2 `engine.ts` closes it.

### Notes instead of ticks (MIDI Phase 5, 2026-09-28)

Tracks now hold free-timed notes (`notes/midi-recording.md`); the perf fixtures build the same patterns as before
(one-step notes on whole steps, see `scripts/perf/fixtures.mjs`). The step callback was timed on the commit before
the note model (`ticks-7315b50`: 7315b50 with only the harness change, a scratch dev server) and on the notes code
with both latency hints (`midi`, `midi-balanced`), same machine, back to back:

| Step callback, mean / p95 ms | ticks (7315b50) | notes, balanced | notes, interactive |
|---|---|---|---|
| small loop / song | 0.455 / 1.4, 0.436 / 1.2 | 0.501 / 1.6, 0.605 / 1.6 | 0.456 / 1.3, 0.435 / 1.2 |
| medium loop / song | 0.434 / 1.2, 0.765 / 2.1 | 0.472 / 1.3, 0.764 / 2.4 | 0.454 / 1.2, 0.769 / 2.1 |
| heavy loop / song | 0.607 / 1.9, 4.346 / 7.0 | 0.611 / 1.9, 4.236 / 5.9 | 0.605 / 1.9, 4.234 / 6.6 |
| heavy pitch sweep | 0.665 / 2.1 | 0.768 / 5.0 | 0.767 / 4.4 |

- **The bucketed notes cost the same as the ticks** (within run-to-run noise, both directions). `heavy` song's
  ~4.2 ms mean and ~180-190 ms max are the same with ticks: hibernation waking containers (node construction) in
  the step callback, not the note lookup.
- **Render load** is unchanged against `tier2-2` and `phase1`: `small`/`medium` within ±6 % either way, `heavy` loop
  0.83 (all runs), `heavy` song 2.14 (interactive) / 2.11 (balanced) against 2.59 (`tier2-2`), 2.97 (`phase1`) and
  2.09 (`ticks-7315b50`). That fixture sits at the machine's limit, so its load swings with the machine; the runs
  of this section were back to back and agree. Session load (`loadMs`, building the fixture) is 484/1080/5011 ms
  against 516/1154/6464 (`tier2-2`) and 558/1180/5853 (`phase1`). No long tasks in the pitch sweeps.
- **'interactive' costs nothing measurable on `heavy`** (loop 0.83 vs 0.79, song 2.14 vs 2.11, sweep 2.39 vs 2.37).
  Headless Chromium's fake device does not behave like hardware here: 'interactive' gets the *larger* callback, 512
  frames (11.6 ms), against 441 (10.0 ms) for 'balanced', so the callback interval columns differ by design and
  render capacity (the share of each callback spent rendering) is the fair comparison; it matches. On real hardware 'interactive' asks for a smaller buffer, i.e. less headroom per callback, which a
  session at the limit (like `heavy` song) would feel first; the setting can be switched off for that.
