# Juicy Loops Bridge protocol (version 1)

Between the studio (browser) and the bridge (desktop). Implementations: `src/protocol.rs` (bridge),
`frontend/src/juicyloops/bridge/protocol.ts` (studio), and the AudioWorklet `bridgeProcessor.ts`, which repeats the
binary layout because worklets cannot import. Golden frames both sides test against: `tests/vectors/*.hex`.

## Transport

One TCP port on **127.0.0.1** (default **47817**):

| Path | What |
|---|---|
| `GET /` | Status page for the person at the computer (shows the pairing token). |
| `/control` | WebSocket. JSON requests, responses and events, text frames. Main thread of the studio. |
| `/audio` | WebSocket. Audio as binary frames. The studio's audio worker. |

Rules, checked before anything else:

* `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, else `403`.
* `Origin`, when present (browsers always send it), must match `allowedOrigins` (`*` matches any run of
  characters), else `403` before the WebSocket handshake.
* The first message on either socket is `hello` with the pairing token; anything else, or a wrong token, gets an
  `unauthorized` error and the socket is closed.

## Control messages (`/control`)

Requests carry a numeric `id` the response repeats:

```json
→ {"id": 7, "type": "create", "pluginId": "vst3:5445…0001", "sampleRate": 48000, "maxBlock": 256, "inputChannels": 0}
← {"id": 7, "ok": true, "result": {"instance": 3, "latency": 32, "hasEditor": true, …}}
← {"id": 8, "ok": false, "error": {"code": "not-found", "message": "The plugin … is not installed on this computer …"}}
```

Error codes: `unauthorized`, `protocol`, `bad-request`, `not-found`, `unsupported`, `plugin-error`, `internal`,
`timeout` (studio side). Messages are sentences for people.

| `type` | Fields | Result |
|---|---|---|
| `hello` | `token`, `protocol` (= 1), `client` | `{bridge, version, protocol, os, formats, editors}`; `editors` false when the bridge has no display |
| `ping` | | `{pong: true}` |
| `listPlugins` | `rescan` (bool, starts a background scan) | `{plugins: [PluginDescription], scanning}` |
| `create` | `pluginId`, `sampleRate`, `maxBlock` (frames, ≤ 16384), `inputChannels` (0 instrument, 2 effect), `outputChannels` (2), `state` (base64, optional), `mode` (`live` or `offline`) | `{instance, plugin, latency, hasEditor, inputChannels, outputChannels, maxBlock}` |
| `destroy` | `instance` | `{}` |
| `getState` | `instance` | `{state}`: the plugin's whole state, base64 |
| `setState` | `instance`, `state` | `{}` |
| `params` | `instance` | `{params: [{id, name, module, min, max, default, value, automatable}]}` (CLAP: plain values; VST3: normalized 0..1) |
| `setParam` | `instance`, `param`, `value` | `{}` (reaches the audio side with the next block) |
| `openEditor` | `instance`, `title` | `{}`: the plugin's own window opens on the desktop |
| `closeEditor` | `instance` | `{}` |
| `transport` | `instance` (optional: else every *live* instance of this connection), `bpm`, `playing` | `{}` |
| `reset` | `instance` | `{}`: voices and tails cleared |

`PluginDescription`: `{id, format: "clap"|"vst3"|"builtin", nativeId, name, vendor, version, kind:
"instrument"|"effect", categories, path}`. Ids: `clap:<CLAP id>`, `vst3:<class id, 32 hex digits>`,
`builtin:<name>`. The studio stores a desktop plugin as `PluginRef.url = "vstbridge:" + id` and its state as
`{"format": "vstbridge", "chunk": "<base64>"}`.

State chunks are the plugin's own: CLAP `state.save` output; for VST3 the bridge's container
`"JLV3" u32 len component-state u32 len controller-state` (little-endian), so both halves of a VST3 plugin travel.

Instances belong to the control connection that made them and are destroyed when it closes (a reloaded page leaves
nothing behind). The studio re-creates its plugins with their last state when the bridge comes back.

Events (no `id`), pushed to the connection that owns the instance:

```json
{"event": "editorClosed", "instance": 3}      the user closed the plugin's window
{"event": "stateChanged", "instance": 3}      the plugin changed its state (edited in its window): read it again
{"event": "latencyChanged", "instance": 3, "latency": 64}
{"event": "pluginsChanged"}                   a scan finished (to every connection)
```

## Audio frames (`/audio`)

After `hello`, binary frames. Little-endian, audio planar `f32` (channel 0's frames, then channel 1's). Every
frame starts with a 24-byte header; byte 0 is the kind and bytes 4..8 the instance.

### `PROCESS` (1), studio → bridge: one block

| At | Type | Field |
|---|---|---|
| 0 | u8 | 1 |
| 1 | u8 | input channels (0..2; a mono input feeds both plugin inputs) |
| 2 | u16 | frames (1..16384; split into the plugin's `maxBlock` by the bridge) |
| 4 | u32 | instance |
| 8 | f64 | start frame: the block's position on the studio's timeline (echoed back) |
| 16 | u16 | event count |
| 18 | u16, u32 | reserved |
| 24 | 8 × events | u16 frame offset in the block (< frames), u8 byte count (3), 3 MIDI bytes, u16 reserved |
| … | f32 × channels × frames | input |

Events are MIDI 1.0 channel messages. Note on/off become CLAP note events (or MIDI for MIDI-only plugins) and VST3
note events; pitch bend, channel pressure and controllers become CLAP MIDI events, and VST3 parameter changes
through the controller's `IMidiMapping`. Events at one frame keep their order.

### `RESULT` (2), bridge → studio

| At | Type | Field |
|---|---|---|
| 0 | u8 | 2 |
| 1 | u8 | output channels (0 unless status is ok) |
| 2 | u16 | frames |
| 4 | u32 | instance |
| 8 | f64 | start frame (as sent) |
| 16 | u16 | status: 0 ok, 1 no such instance, 2 plugin error, 3 bad request |
| 18 | u16 | reserved |
| 20 | u32 | microseconds the bridge spent |
| 24 | f32 × channels × frames | output |

One `RESULT` per `PROCESS`, in order per connection.

### `RENDER` (3), studio → bridge: a whole range as fast as possible (offline)

| At | Type | Field |
|---|---|---|
| 0 | u8 | 3 |
| 1 | u8 | input channels |
| 2 | u16 | chunk size in 1024-frame units (0 = 64) |
| 4 | u32 | instance |
| 8 | f64 | frames to render (whole number) |
| 16 | u32 | event count |
| 20 | u32 | reserved |
| 24 | 8 × events | u32 absolute frame, 3 MIDI bytes, u8 byte count |
| … | f32 × channels × frames | input (for an effect; empty for an instrument) |

The bridge resets the instance (voices, tails), renders from frame 0, and answers with `RENDER_RESULT` chunks as
they are done.

### `RENDER_RESULT` (4), bridge → studio

| At | Type | Field |
|---|---|---|
| 0 | u8 | 4 |
| 1 | u8 | output channels |
| 2 | u16 | reserved |
| 4 | u32 | instance |
| 8 | f64 | the chunk's first frame |
| 16 | u32 | frames in this chunk |
| 20 | u32 | flags: 1 last chunk, 2 error (the payload is then a UTF-8 message) |
| 24 | f32 × channels × frames | output |

Frames up to 512 MiB are accepted (a `RENDER` with input carries the whole input).

## How the studio uses it

**Live** (`bridgeProcessor.ts`, an AudioWorklet per plugin, talking to the audio worker through a MessagePort; no
SharedArrayBuffer, the page is not cross-origin isolated):

* Instrument: block `[S, S+256)` is requested when the playhead reaches `S − 2048`, with the MIDI events whose
  context time falls inside it; the answer plays at `S`. Sequenced notes (scheduled 200 ms ahead) are therefore
  sample-exact; a live note lands in the next block not yet requested.
* Effect: the input is captured in 256-frame blocks; block `[S, S+256)` plays at `S + 1280`.
* A block that is missing at its time plays as silence (counted as an underrun); one that comes too late is
  dropped. Request buffers circulate (worklet → worker → back filled with the answer), so the audio thread does
  not allocate per block.

**Export** (`offline.ts`): the OfflineAudioContext is paused (`suspend`) where the bridge has work:

* Instrument: at frame 128, after the sequencer scheduled every note, one `RENDER` for the whole export; the answer
  plays from an AudioBuffer, sample-aligned.
* Effect: a worklet captures the input in 512-frame blocks; at each multiple of 512 the last block goes out as a
  `PROCESS` and its answer is scheduled at once (so the output is 512 frames late). A failing bridge leaves the
  plugin silent; the export always finishes.

## Versioning

`hello.protocol` must equal the bridge's `PROTOCOL_VERSION`; otherwise the bridge answers with code `protocol` and the
studio asks to update the older side. New optional JSON fields and new event names are not version changes; any
change to a binary layout or a field's meaning is.
