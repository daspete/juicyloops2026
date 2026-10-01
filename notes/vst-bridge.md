# VST bridge: desktop plugins in the studio

Paths relative to `juicyloops/`. Built 2026-10-01. Browsers cannot load native plugins, so a small desktop app (the
**Juicy Loops Bridge**, `vst-bridge/`) hosts them and streams their sound to the studio over a local WebSocket.
User and build docs: `vst-bridge/README.md`; wire protocol: `vst-bridge/PROTOCOL.md`.

## Choices

| Question | Answer | Why |
|---|---|---|
| Language | Rust, like `dsp/` | One toolchain, Docker builds, Windows cross-compiles from Linux. |
| CLAP | `clack-host` 0.2 (MIT/Apache) | Safe, maintained (released 2026-09), has an example host to follow. |
| VST3 | own host on the `vst3` crate 0.3 (MIT/Apache bindings) | The VST3 SDK is **MIT since VST 3.8 (Oct 2025)**, so a closed-source host needs no Steinberg agreement. `vst3-host` (MIT) was looked at: large, macOS-first, unverified on Linux/Windows; used only as a reference for COM shapes and as a test fixture. `vst3-sys` is GPL-3 (not used). JUCE is GPL/commercial (not used). |
| VST2 | no | SDK withdrawn by Steinberg in 2018; cannot be distributed or newly licensed. |
| Transport | WebSocket on 127.0.0.1, JSON control + binary audio, `tungstenite` (blocking, one thread per connection) | Few connections; blocking I/O keeps the audio path simple and fast (~0.15 ms per block). |
| Windows for editors | `winit` (Apache-2.0), X11 on Linux | Plugin GUIs are X11/HWND/NSView children; winit gives all three. |
| Browser audio | AudioWorklet + dedicated Worker owning the audio socket, MessagePort between them | No SharedArrayBuffer (no cross-origin isolation); the main thread never touches audio. |
| Integration | `PluginRef.url = "vstbridge:<id>"`; `createPlugin` in `wamHost.ts` hands those to `bridge/bridgePlugin.ts` | Synth tracks (`model: 'plugin'`), effect slots, saves, undo, copy/paste, hibernation work unchanged. |

## How it fits together

```
studio main thread ──/control (JSON)──┐
  bridge/client.ts (pairing, requests, events, reconnect)
                                       │        juicyloops-bridge
AudioWorklet (bridgeProcessor.ts) ─port─ Worker (audioWorker.ts) ──/audio (binary)──  server.rs ─ engine.rs (main thread:
  jitter buffer, per plugin                                                              plugins, editors) ─ audio.rs ─ CLAP / VST3 / built-in
```

* **Bridge**: `Plugin` (main-thread half: state, params, editor) and `Processor` (audio half) traits; CLAP
  (`clap_host.rs`), VST3 (`vst3_host/`), and two built-in test plugins. Main thread = a winit event loop (or a
  headless loop) that runs jobs from the connection threads. Audio blocks are processed on the audio connection's
  thread; blocks bigger than the plugin's maximum are split with their events. Scans run each new file in a child
  process (`--scan-one`) with a timeout, cached by path + mtime.
* **Studio**: `bridge/protocol.ts` (shared layout), `client.ts` (one per page, reactive state for the UI, retains
  the connection while plugins use it and reconnects, then re-creates instances with their last state),
  `audioWorker.ts` (relay; copies answers into the request buffers it holds, so worklets never allocate per block),
  `bridgeProcessor.ts` (no imports), `bridgePlugin.ts` (the WAM-shaped node and module, the desktop-window panel),
  `offline.ts` (exports). UI: `components/plugins/DesktopPlugins.vue` inside the plugin browser.

## Timing (measured 2026-10-01, WSL2, Chromium headless, 44.1 kHz)

| | Result |
|---|---|
| Live instrument, sequenced note | lands on its frame (0–3 frames; the 3 are the test synth's attack crossing the threshold) for the built-in sine, Clack's CLAP polysynth and a VST3 test synth |
| Round trip of a 256-frame block (worklet → bridge → worklet) | 256 frames typical, 1024 worst (resolution: 128-frame quanta); bridge time per block ~0.15 ms; no underruns |
| Live effect | output exactly 1280 frames (29 ms) after its input, at the right gain |
| Export, instrument | one `RENDER` for the whole range: 2 s rendered in 2 ms on the bridge; first sample on frame 0 of the exported file |
| Export, effect | 512 frames late (11.6 ms); a 4 s export with a bridge synth + bridge effect took 0.5 s |
| Bridge restart | the studio reconnects (backoff 1–10 s) and its plugins play again with their state |

## A fix on the way: WAM effects silent in exports

`plugins/WamEffect.ts` connected the plugin natively and then removed its own input→output path. In an
OfflineAudioContext standardized-audio-context makes the native connections only when rendering starts, and only
for nodes it reaches from the destination; with no path of its own the input was never reached, nothing upstream
was connected to it, and the plugin heard silence. A muted gain from input to output keeps it reachable. Checked:
Cmajor Tremolo, Filter EQ and Convolution Reverb (the curated effects marked "Live only" because they were silent
in exports) render with sound now, and were silent with the muted path removed. Their "Live only" flags in
`catalog.ts` stay for now: `liveRender.spec.ts` (the real-time export's tests) uses Tremolo as its live-only
example; drop the flags when that test moves to a still-live-only plugin (Pro-54, Synth-101).

## Tests

* Rust (`bash vst-bridge/scripts/test.sh --fixtures`): 40 tests: unit (protocol, config, scanning, blocks, render,
  engine, VST3 COM objects), sockets end to end, golden frames shared with TypeScript, and real plugins through both
  hosts (Clack's polysynth + gain as CLAP, `vst3-rs`' gain + `vst3-host`'s TestSynth as VST3; MIT/Apache, built from
  pinned sources by `scripts/fixtures.sh`, never shipped).
* `bash vst-bridge/scripts/check.sh`: rustfmt, clippy `-D warnings`, `cargo check` for Windows and macOS.
* Studio: `src/juicyloops/__tests__/bridge.spec.ts` (19 tests: protocol against the golden frames, the worklet in
  Node with a fake bridge: ahead-of-time requests, note offsets, late notes, gaps and recovery, effect delay,
  buffer reuse; the relay; the client with a fake server; export pauses).
* Chromium end to end: `node frontend/scripts/bridge/e2e.mjs` (pairing UI, live timing of three plugins, effect
  delay, the studio's own export with a bridge synth and effect, reconnect). All checks passed.
* By hand on WSLg: a VST3 editor window (TestSynth's view) opens and closes from the studio.

## What remains

1. **Plugin delay compensation.** Live bridge effects are 1280 frames late, export ones 512, plus the plugin's own
   reported latency; the mixer does not compensate. Hooks needed (files owned elsewhere): the node exposes
   `bridgeLatency()` (seconds) on the WAM node of a `WamEffect`; `render.ts` could add it to `latency` per path the
   way it does for compressors, and live, `mixBus.ts`/`engine.ts` would need per-path delays.
2. **Real-time export** (being built by another agent) records the master while playing: bridge plugins then
   export exactly as they sound live, including effects without the 512-frame offset. Nothing else needed.
3. **Live MIDI keyboard latency** for bridge instruments is up to ~50 ms (the look-ahead). An adaptive look-ahead
   (shrink while round trips are short; the worklet already measures them) would bring it to ~10 ms.
4. **Crash isolation per instance.** Scans are isolated; a plugin crashing while playing takes the bridge down (the
   studio reconnects when it is restarted). Out-of-process instances (one child per plugin, shared memory audio)
   would contain it.
5. **Editors**: CLAP and VST3 embedded editors work through winit; floating CLAP editors untested; Linux VST3
   editors get an `IRunLoop` (timers + fds) but only TestSynth's (non-drawing) view was tried. Window position and
   always-on-top are not remembered. macOS/Windows editors are compile-checked only.
6. **Not yet passed on**: song position (only tempo and play state go to plugins), VST3 note expression, MIDI
   output of plugins, output parameter changes back to the VST3 controller, sidechain inputs (aux buses get
   silence), surround.
7. **Platforms**: Linux built and tested; Windows cross-compiled (MinGW) but not run; macOS type-checked only (needs
   a Mac or the CI workflow in `vst-bridge/ci/`). Releases need code signing and a download page (the studio links
   to the GitHub releases page for now). Safari cannot reach `ws://127.0.0.1` from an https page.
8. A project opened while the bridge is not running shows the plugin's load error; re-picking the plugin (or
   reloading) after starting the bridge loads it. Plugins already playing do come back on their own.

## Sources (2026-10-01)

* VST3 under MIT: [KVR](https://www.kvraudio.com/news/steinberg-moves-vst-3-sdk-to-mit-open-source-license-asio-now-gplv3-65179),
  [Steinberg licensing page](https://steinbergmedia.github.io/vst3_dev_portal/pages/VST+3+Licensing/VST3+License.html)
* [`vst3` crate](https://github.com/coupler-rs/vst3-rs), [Clack](https://github.com/prokopyl/clack),
  [`vst3-host`](https://github.com/HelgeSverre/rust-vst3-host)
