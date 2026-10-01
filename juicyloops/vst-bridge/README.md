# Juicy Loops Bridge

A small desktop app that hosts the **VST3 and CLAP plugins installed on your computer** and plays them for the
Juicy Loops studio in your browser. Browsers cannot load native plugins; the bridge runs them next to the browser and
streams audio back and forth over a local WebSocket. In the studio a desktop plugin works like any other plugin:
on synth tracks, in effect racks, saved with the project, in undo, copy/paste and exports. Its own window opens on
the desktop.

Status: working MVP (2026-10-01), see [`notes/vst-bridge.md`](../../notes/vst-bridge.md) for the design, the
measurements and what is left. Wire protocol: [`PROTOCOL.md`](PROTOCOL.md).

## Using it

1. Start `juicyloops-bridge` (a terminal window shows what it does; leave it open while you work).
   It prints a **pairing token** and the address of a status page (`http://127.0.0.1:47817/`) that shows it too.
2. In the studio, open **Add plugin** (a synth track's *Plugin* model, or *Add effect → plugin*). The section
   **Desktop plugins (VST bridge)** asks for the token once; the browser remembers it.
3. Pick a plugin. **Open** in its device card opens the plugin's own window on your desktop.

The first start scans the standard plugin folders (below) in the background; the ↻ button in the studio scans
again (after installing something). Plugins that crash while being scanned are skipped, not fatal: each new file is
opened in a child process.

| OS | CLAP folders | VST3 folders |
|---|---|---|
| Windows | `%COMMONPROGRAMFILES%\CLAP`, `%LOCALAPPDATA%\Programs\Common\CLAP` | `%COMMONPROGRAMFILES%\VST3`, `%LOCALAPPDATA%\Programs\Common\VST3` |
| macOS | `/Library/Audio/Plug-Ins/CLAP`, `~/Library/Audio/Plug-Ins/CLAP` | `/Library/Audio/Plug-Ins/VST3`, `~/Library/Audio/Plug-Ins/VST3` |
| Linux | `~/.clap`, `/usr/lib/clap`, `/usr/local/lib/clap` | `~/.vst3`, `/usr/lib/vst3`, `/usr/local/lib/vst3` |

`CLAP_PATH` is honoured; more folders go in `extraPluginPaths` or `--plugin-path`. VST2 is not supported (its SDK
was withdrawn by Steinberg in 2018 and may not be distributed; new hosts cannot license it).

### Timing

* **Instruments**: blocks are rendered ahead of time (2048 frames, ~43 ms), so notes from the sequencer (scheduled
  200 ms early) land on their exact sample: **no audible latency for sequenced notes**. Notes you play live on a
  MIDI keyboard arrive "now" and play up to ~50 ms late.
* **Effects**: their input only exists as it plays, so the output is 1280 frames (~27–29 ms) behind the input. The
  studio's mixer does not compensate this yet (see notes).
* **Exports**: instruments are rendered in one go at full speed (sample-exact); effects come out 512 frames
  (~11 ms) late in exports.
* Measured on Linux/WSL2 with Chromium: block round trip 256 frames typical (two 128-frame render quanta, the
  quantisation of the measurement), 1024 at worst, no dropouts; the bridge itself needs ~0.15 ms per block.

### Settings

`config.json` in the settings folder: Windows `%APPDATA%\Juicy Loops Bridge`, macOS
`~/Library/Application Support/Juicy Loops Bridge`, Linux `~/.config/juicyloops-bridge` (or `$JUICYLOOPS_BRIDGE_HOME`).
The plugin cache `plugins-cache.json` lives next to it.

```json
{
  "port": 47817,
  "allowedOrigins": ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*", "http://juicyloops.test", "https://juicyloops.daspete.at"],
  "token": "made on first start",
  "extraPluginPaths": [],
  "scanClap": true,
  "scanVst3": true
}
```

Command line (`--help`): `--port <n>`, `--config <file>`, `--allow-origin <o>` (repeatable, `*` wildcards),
`--plugin-path <dir>` (repeatable), `--no-scan`, `--builtin-plugins` (two test plugins: a sine synth and a gain),
`--headless` (no plugin windows), `--reset-token`. `JUICYLOOPS_BRIDGE_LOG=debug|info|warn` sets the log level.

### Security

The bridge loads native code (the plugins you installed) and plays it for a web page, so it is strict about who
talks to it:

* It listens on **127.0.0.1 only**; nothing on the network can reach it.
* Every request must name `127.0.0.1`/`localhost` in its `Host` header (defeats DNS rebinding).
* WebSockets from a browser must come from an **allowed origin** (the studio's).
* Every WebSocket must present the **pairing token** first (compared in constant time). The token is 100 random
  bits, kept in the settings file (mode 0600 on Unix); `--reset-token` makes a new one.
* The studio never sends file paths or code: only plugin ids from the bridge's own list.

### Browser notes

* Chrome and Edge 142+ ask once whether the studio may reach "devices on your local network" when the studio is
  served from the internet: allow it. Pages on `localhost`/`127.0.0.1` do not ask.
* Firefox allows `ws://127.0.0.1` from https pages. **Safari blocks it** (mixed content); use another browser.

## Building

Everything builds in Docker; the host needs only `bash` and `docker`.

| What | Command | Output |
|---|---|---|
| Linux (x86_64, glibc ≥ 2.36) | `bash scripts/build.sh` | `dist/linux/juicyloops-bridge` |
| Windows (x86_64, cross-compiled with MinGW) | `bash scripts/build-windows.sh` | `dist/windows/juicyloops-bridge.exe` |
| macOS (universal) | `bash scripts/build-macos.sh` **on a Mac** (Apple's SDK cannot go in a Docker image) | `dist/macos/juicyloops-bridge` |
| Lints, formatting, type-check of all three OSes | `bash scripts/check.sh` | |
| Tests | `bash scripts/test.sh [--fixtures]` | |

The GitHub Actions workflow [`.github/workflows/vst-bridge.yml`](../../.github/workflows/vst-bridge.yml) builds all
three (macOS on a `macos-14` runner) on every push to `main` that touches the bridge, and on demand from the Actions
tab. When both builds pass, it publishes them on the
[Releases page](https://github.com/daspete/juicyloops2026/releases) as `bridge-v<version>` (the version in
`Cargo.toml`): a zip for Windows and macOS, a tar.gz for Linux, and `SHA256SUMS.txt`. Another build of the same
version replaces that release's files; bump the version for a new release. Releases should be
code-signed (Windows: `signtool`; macOS: Developer ID + notarization, the script prints the command), otherwise
SmartScreen and Gatekeeper warn on first start.

On Linux the bridge needs an X11 display for plugin windows (also under Wayland, through XWayland); without one it
runs headless and plugins play without their windows.

## Tests

`bash scripts/test.sh` runs 40 Rust tests:

* unit tests: protocol (JSON and binary frames), settings and origin/token checks, scanning and its cache, block
  splitting, render mode, the engine (instances, state, ownership), the VST3 host's COM objects;
* `tests/server.rs`: the real server over sockets (pairing refused/accepted, foreign origin, DNS-rebound host,
  live blocks with timing, render mode, effects, state between instances, cleanup on disconnect);
* `tests/vectors.rs`: golden binary frames that the studio's TypeScript tests read too (both sides agree byte for byte);
* `tests/plugins.rs`: real plugins through the real CLAP and VST3 hosts: Clack's example polysynth and gain (CLAP),
  `vst3-rs`' example gain and `vst3-host`'s TestSynth (VST3), all MIT/Apache, built by `scripts/fixtures.sh`
  (skipped with a note when not built).

The studio side has unit tests in `frontend/src/juicyloops/__tests__/bridge.spec.ts` (protocol, the worklet's
jitter buffer and timing, the audio relay, the control client, export pauses) and an end-to-end check in Chromium,
`node frontend/scripts/bridge/e2e.mjs` (needs a dev server; see its header).

## Code map

| File | What |
|---|---|
| `src/main.rs` | command line, start-up, the main thread (window loop or headless) |
| `src/server.rs` | HTTP status page, WebSocket endpoints, the per-connection audio worker |
| `src/protocol.rs` | JSON messages and binary frames |
| `src/engine.rs` | the main thread's state: instances, plugin list, editors, events |
| `src/audio.rs` | the audio side of an instance: block splitting, render mode |
| `src/plugin.rs` | the format-independent plugin traits (`Plugin`, `Processor`) |
| `src/clap_host.rs` | CLAP through Clack |
| `src/vst3_host/` | VST3 through the `vst3` crate: module loading, host COM objects, instance |
| `src/builtin.rs` | the bridge's test plugins |
| `src/scan.rs` | folders, crash-proof scanning, cache |
| `src/gui.rs` | winit windows for plugin editors |
| `src/config.rs` | settings, token, origins, command line |

## Licences

The bridge is part of Juicy Loops (proprietary). Its dependencies are all permissive: `clack-host`/`clack-extensions`
(MIT or Apache-2.0), `vst3` (MIT or Apache-2.0; bindings to the VST3 SDK, which Steinberg relicensed under **MIT**
with VST 3.8 in October 2025, so no Steinberg agreement is needed), `tungstenite` (MIT/Apache-2.0), `winit`
(Apache-2.0), `serde`, `base64`, `crossbeam`, `libloading`, `getrandom`, `libc` (MIT/Apache-2.0). No GPL code is
linked (JUCE and the GPL-only `vst3-sys` are not used). The test fixtures are MIT/Apache plugins built from source
and never shipped. "VST" is a trademark of Steinberg Media Technologies GmbH; using the name in a product needs their
trademark terms (the MIT licence covers the code only).
