# MIDI input, recording and a free-timed piano roll

Plan for playing tracks live with a MIDI keyboard, recording what is played, and a piano roll that places
notes anywhere (not only on steps), with grid snap and a separate quantize command. Paths are relative to
`juicyloops/frontend/src/` unless noted.

## Decisions

| Topic | Decision |
|---|---|
| Note model | **Notes replace ticks.** Every synth and sample track holds a list of notes with a free `start` and `length` in fractional steps, plus note and velocity. Chords are allowed. The step grid becomes a view onto the notes. Old sessions are converted when loaded. |
| MIDI routing | **Armed tracks.** Each track has an arm button. Every armed track plays and records what comes in from any enabled input on any channel. Selecting a track arms it automatically when nothing else is armed. |
| Recording | Overdub while the loop plays (default), a **replace** toggle, a **count-in and metronome** (both toggleable), and recording in **song mode** as well. |
| Song-mode recording | Notes go into the armed track's pattern, at the position inside the clip that is playing, so every clip of that container plays them. If the container is not playing at that moment, the notes are heard but not recorded. |
| Grid snap | Snaps to **grid resolutions**: off, 1/4, 1/8, 1/16, 1/32, 1/64, 1/8T, 1/16T, 1/32T. Snap only affects editing; recorded notes keep the timing they were played with until the user runs **Quantize**. |
| MIDI scope | Note on/off with velocity, **sustain pedal (CC64)**, **pitch bend** and **MIDI learn** (any CC to any automatable parameter; CC moves are recorded into automation). |
| Sample note length | A per-track **one-shot/gate** toggle. One-shot (the default) plays the slice out as today, so old sessions sound the same. Gate stops the voice with a short fade at the end of the note. |
| Latency | A **"low latency" setting**, on by default, creates the audio context with `latencyHint: 'interactive'`. Turning it off uses `'balanced'`. The change takes effect on the next start. |

## Where things are today

- `ticks/BaseTick.ts`, `SynthTick.ts` and `SampleTick.ts` hold one tick per step: `isActive`, `volume`, `note`,
  and for synth ticks a `duration` from the fixed `NOTE_LENGTHS`. This allows one note per step, and turning a
  step off keeps its note.
- `tracks/BaseTrack.ts`:
  - `ticks: TTick[]` (its length is the pattern length).
  - `play(step, time)` applies step automation, then calls `trigger(step, time)`.
  - Pattern tools: `activateEveryNth`, `randomize`, `rotateTicks`, `clear`.
  - `capture`/`restore`/`serialize` store ticks.
- The UI is built on ticks: `components/tracks/TickGrid.vue`, `StepValueLane.vue` (velocity per step),
  `TrackPatternSettings.vue`, `noteDrag.ts`, `PianoRoll.vue` (one note per step, cells) and `SamplePianoRoll.vue`.
  The song previews `ClipPreview.vue` and `PatternPreview.vue` draw patterns too.
- Engine code that also reads ticks:
  - `render.ts` (`loopLength` uses `ticks.length`), `hibernate.ts` (voice tails) and `sessionFile.ts`
    (`FORMAT_VERSION = 1`);
  - the Rust synth ABI v2 (`note_on` needs a known duration, and there is no `note_off`);
  - `tracks/synthEngine.ts` (Tone fallback).
- Automation points already have a `step` position that can be fractional (`automation.ts`, `valueAt`). They are
  applied once per step.
- Notes are strings such as `'C5'`. `noteIndex('C5') === 60`, so a MIDI note number `n` maps to `noteAt(n)`. (Changed
  in Phase 4: standard pitch, `noteAt(n - 12)`; see "As built (Phase 3)".)

---

## Phase 1: Note model, scheduling and migration (engine and step grid)

### Model
- New `juicyloops/notes/Note.ts` (or `patternNotes.ts`):
  ```ts
  interface PatternNote { id: string; note: string; start: number; length: number; velocity: number }
  ```
  - `start` and `length` are in steps (one step is a 16th) and can be fractional. `velocity` is 0..1.
  - A note starts inside the pattern (`0 <= start < track.length`). Its length may run past the pattern end;
    the tail rings across the wrap.
- `BaseTrack` replaces `ticks` with `notes: PatternNote[]`, kept sorted by `start`, and `length: number`.
  - The generic tick type goes. Sample tracks keep what their ticks had (the note chooses the pitch or slice).
  - Every edit goes through a few methods (`addNote`, `updateNote`, `removeNotes`, `setNotes`) that keep the
    order and bump a `revision` counter, which the scheduler's cache uses.
- **Step view helpers**, pure, in `juicyloops/notes/stepView.ts`:
  - `notesStartingIn(notes, step)`: a step cell is lit when any note starts in `[step, step + 1)`.
  - `toggleStep(track, step)`: turns a lit cell off by removing the notes that start there. An empty cell gets a
    one-step note at the track's `stepNote` (the last pitch placed, default `C5`, or `SAMPLE_ROOT_NOTE` on sample
    tracks), at velocity 1. Synth notes get the track's default length (1 step).
  - The velocity lane shows and sets the velocity of the notes starting in a step.
  - Pattern tools on notes:
    - `activateEveryNth` makes one-step notes.
    - `randomize` works the same way.
    - `rotate` shifts every note by ±1 step and wraps its start.
    - `clear` removes all notes.
    - `shiftOctave` transposes all notes.
    - `setAllNoteLengths` sets the length of every note.
- **Migration.**
  - `TrackState` and `TrackSnapshot` store `notes` instead of `ticks`, plus `length`.
  - `restore` and `sessionFile` load read old `ticks` arrays: every active tick becomes a note at `start = index`,
    with `length = noteLengthSteps(duration)` for synth ticks or 1 for sample ticks, the tick's note and
    `velocity = volume`. Inactive ticks are dropped.
  - `sessionFile.ts` moves to `FORMAT_VERSION = 2` and still reads version 1.
  - A unit test round-trips a v1 fixture.

### Scheduling
- `BaseTrack.play(step, time)` still runs once per step. For the step's position `p = stepOf(step)` it schedules
  every note that starts in `[p, p + 1)` at `time + (note.start - p) * secondsPerStep`.
  - A per-track bucket index (`notesByStep: PatternNote[][]`) is rebuilt only when `revision` or `length`
    changes, so the step callback does no allocation or scanning.
  - `secondsPerStep` comes from the transport's BPM at `time`.
- `trigger(note, time, durationSeconds)` replaces `trigger(step, time)`:
  - Synth tracks call `engine.triggerAttackRelease(note.note, duration, time, velocity)`.
  - Sample tracks start a voice. In **gate** mode the voice stops (with the fade) at `time + duration`; in
    one-shot mode it plays the slice out as today. `cutsNotes` behaves as before.
- **Other code that reads the pattern:**
  - `render.ts` `loopLength` uses `track.length`.
  - `hibernate.ts` voice tails use the longest note (and the release).
  - `stepOf` and pattern wrapping stay the same.
- **Step automation** is still applied at step starts. The finer resolution for recorded CC comes in Phase 4.

### UI to adapt in this phase (so everything compiles and works as before)
- `TickGrid.vue`, `StepValueLane.vue`, `TrackPatternSettings.vue`, `noteDrag.ts` and the synth step grid's
  length drag work on notes through the step-view helpers.
- `PianoRoll.vue` and `SamplePianoRoll.vue` keep working on a minimal adaptation: notes that start in a cell show
  in that cell. Phase 2 rewrites them.
- `ClipPreview.vue` and `PatternPreview.vue` draw notes at their real positions.
- `JuicySynthTrack`, `JuicySamplerTrack`, `JuicyMicrophoneTrack` and `usePlayheadClass`: the playhead lights
  cells as before.
- **Tests:**
  - `ticks.spec.ts` becomes `notes.spec.ts`: model, step view and pattern tools.
  - `trackLength.spec.ts` checks that `setLength` drops notes starting past the end and keeps their tails.
  - migration from v1, `render.spec` loop length, and the bucket index.
- **Browser check:** an old session file (v1) loads and plays exactly as before (onset times in an offline
  render compared with HEAD's render of the same file), and the step grid edits and plays.

---

## Phase 2: Free-timed piano roll with grid snap and quantize

- **Rewrite `PianoRoll.vue`.** Rows stay the same (`RollRow`, virtual scroller). Notes become absolutely
  positioned bars (`left = start * cellWidth`, `width = length * cellWidth`), no longer cells.
  - **Tools:**
    - Click an empty spot to add a note at the snapped position, using the last used length (default: one grid
      unit).
    - Drag a note to move it in time and pitch.
    - Drag either edge to resize.
    - Alt/Option while dragging turns snap off.
    - Shift-click or a rubber band selects several notes, and Ctrl/Cmd+A selects all.
    - Delete/Backspace removes notes, and Ctrl/Cmd+D duplicates them.
    - Ctrl/Cmd+C and V copy and paste at the playhead or at the selection's end.
    - The arrow keys move notes: ±1 grid unit or ±1 semitone, and with Shift an octave or a bar.
  - **Chords:** several notes may share a start. Overlapping notes of the same pitch are allowed, and the later
    one is drawn on top.
  - **Velocity lane** at the bottom of the roll: one stem per note, drag to change it, and the stems follow the
    selection.
  - **Grid:** vertical lines at the snap resolution, with bar and beat lines stronger. Triplet grids draw their
    own lines.
  - **Playhead:** a beam at the fractional position.
- **Snap control** in the roll header offers off, 1/4, 1/8, 1/16, 1/32, 1/64, 1/8T, 1/16T and 1/32T, stored per
  roll in localStorage. It is a pure helper: `snap(value, grid)` in `notes/grid.ts`.
- **Quantize button** plus a small popover: which grid, a strength from 0 to 100 % (default 100 %), and whether
  to quantize ends as well. It applies to the selection, or to every note when nothing is selected. One undo step.
- **`SamplePianoRoll.vue`** uses the same component. Its rows are slices or keys, and the gate/one-shot toggle
  sits in the roll's footer slot.
- Every edit goes through the track's note methods, so history (undo/redo) captures it like any other edit.
- **Tests:** `grid.spec.ts` (snap for every resolution including triplets; quantize strength and ends), plus a
  Playwright check that a note can be added, moved, resized, snapped and quantized, and that the result plays at
  the expected times (offline render onsets).

---

## Phase 3: MIDI input and live playing

- **New `juicyloops/midi/`:**
  - `midiInput.ts`:
    - Wraps the Web MIDI API (`navigator.requestMIDIAccess({ sysex: false })`), requested on a user gesture
      (the "Enable MIDI" button, or automatically once the user has granted it before).
    - Lists devices, handles hot-plugging (`statechange`) and can enable or disable each input. The enabled
      inputs are saved in localStorage.
  - `messages.ts`: a pure parser for note on/off (note-on with velocity 0 counts as off), CC (with CC64 as
    sustain), pitch bend (14 bit, mapped to -1..1), and channel.
- **Arming.**
  - `BaseTrack.isArmed` is transient: not saved and not in history.
  - An arm button sits in `TrackShell.vue`.
  - When nothing is armed, the selected track counts as armed. `useJuicyLoops` has the selection.
  - A router in `midi/router.ts` sends every event to every armed track, on all channels.
- **Live notes** bypass the look-ahead and are triggered at `context.currentTime`:
  - `track.noteOn(id, note, velocity, time)` and `track.noteOff(id, time)`, where the id is
    `${input}:${channel}:${noteNumber}`.
  - **Synth, Rust engine (ABI v3):**
    - `note_on(frame, id, hz, velocity, duration_frames)`, where `duration_frames < 0` holds the note until
      `note_off(frame, id)`;
    - `set_param(frame, BEND, value)` for pitch bend.
    - Update `synthProcessor.ts`, `SynthVoices.ts` and `synthProtocol.ts`, rebuild with
      `bash dsp/scripts/build.sh` and keep `check.sh` green.
  - **Synth, Tone engine:** `triggerAttack` and `triggerRelease`. In mono (cut) mode the last note wins, and on
    release it falls back to a note still held.
  - **Sample tracks:** a voice per note. In gate mode `noteOff` stops the voice with the fade; one-shot ignores
    `noteOff`.
  - **Sustain pedal:** note-offs that arrive while the pedal is down are held and released when the pedal comes
    up.
- **Pitch bend** becomes a new synth parameter `bend` (in semitones, range ±2 by default, with a per-track range
  setting) that can be automated like any parameter. The Rust engine gets it via `set_param`, the Tone engine via
  `detune`. Live bend applies right away with a short ramp.
- **MIDI learn:**
  - A "Learn" mode in the top bar highlights every knob. The user clicks a knob and moves a controller, and the
    mapping `{ cc, channel | 'all', target: AutomationTarget, param }` is stored in the session: a new
    `midiMappings` in `SessionState`, persisted in the session file and in history.
  - Mapped CC messages set the parameter's stored value, like turning the knob. The history entry is coalesced,
    so one controller gesture is one undo step.
  - Mappings can be listed and removed in a small popover.
- **Latency setting:**
  - `engine.ts` reads `lowLatency` from localStorage when the module loads (default on) and creates the context
    with `'interactive'` or `'balanced'`. `lookAhead` stays at 0.2 s for scheduled notes.
  - The toggle sits in the settings or MIDI popover and notes that the change takes effect on the next start.
- **UI:** a MIDI indicator in the top bar (off, enabled, or activity flash), a device list popover with the
  enable toggles, the arm buttons, and the learn mode.
- **Tests:**
  - Unit: the message parser, the router (armed and selected tracks), the sustain logic and the mapping store.
  - `cargo test` for the ABI v3 note_off and bend.
  - Playwright, with a fake `navigator.requestMIDIAccess` injected via `addInitScript`: a note-on sounds within
    one render quantum after the event (Meter or analyser), note-off releases, sustain holds, bend changes the
    measured pitch, and learn maps a CC onto a knob.

**As built (Phase 3):**

- **Files.** `juicyloops/midi/`: `messages.ts` (parser), `liveNotes.ts` (`SustainGate`, `NoteStack`), `router.ts`
  (`MidiRouter`), `mappings.ts` (MIDI learn store), `midiInput.ts` (Web MIDI wrapper). `juicyloops/latency.ts` (the
  setting). `composables/useMidi.ts` (inputs, router, learn, latency; module-level state) and `useMidiLearn.ts` (the
  knob side of learn, no engine import). UI: `components/midi/MidiPanel.vue` (top bar), arm button in `TrackShell.vue`,
  `learn` prop on `JuicyKnob.vue` (+ `EffectKnob`, `BusStrip`/`MixPanel`, `SynthEnvelopeSettings`, `DetailPanel`
  provides the owner), `settings/SynthBendSettings.vue`. Browser checks: `frontend/scripts/midi/live.mjs` with the
  reusable fake `frontend/scripts/midi/fakeMidi.mjs`.
- **Parser** (`parseMidiMessage(data)`): `noteon` (velocity 0..1), `noteoff` (also note-on with velocity 0), `cc`
  (0..127), `sustain` (CC64, down at >= 64), `bend` (14 bit to -1..1, both ends exactly ±1), `allnotesoff` (CC120 and
  CC123). Channels 0..15. Everything else (aftertouch, program change, system, sysex) is `null`.
- **Note numbers** (changed in Phase 4, the user's decision): **standard pitch** for every track type. Key `n` plays
  `midiNoteName(n) = noteAt(n - 12)` (`midi/messages.ts`, the one mapping used by live playing and recording): MIDI 60
  (middle C) is `'C4'` = 261.6 Hz, 69 is `'A4'` = 440 Hz. A sampler plays its sample unchanged at its root `'C5'`, which
  is key 72 (the first slice of a cut sample). Recorded notes store the same name that was played. (Phase 3 first shipped
  `noteAt(n)`, an octave higher.)
- **Routing** (`MidiRouter`): every event goes to every armed track, any channel; with none armed, the selected track
  (`useWorkspace().selectedTrack`) plays. (Changed later, the user's decision: the selected track always plays, see
  "As built (selected track plays live)" below.) A note-off goes to the tracks its note-on went to, pedal-up reaches every
  track the pedal went down on, a bend back to the centre reaches every track that was bent. An input that is
  unplugged or switched off gets `allNotesOff` for its notes; CC120/123 and the popover's "All notes off" stop all.
- **Recorder hook.** `useMidi().onMidiEvent(listener)` (or `router.subscribe`) hands every routed event to the
  listener, after the tracks got it:
  ```ts
  interface MidiRouterEvent {
      type: 'noteon' | 'noteoff' | 'cc' | 'sustain' | 'bend' | 'allnotesoff';
      input: string;        // Web MIDI input id
      channel: number;      // 0..15
      id?: string;          // notes: `${input}:${channel}:${note}`, the same for a note-on and its note-off
      note?: number;        // notes: MIDI note number (noteAt(note) is the pattern note)
      velocity?: number;    // notes: 0..1
      cc?: number;          // cc and sustain (64)
      value?: number;       // cc/sustain 0..127, bend -1..1
      timeStamp: number;    // MIDIMessageEvent.timeStamp, performance.now() clock
      time: number;         // context.currentTime when it was played
      trackIds: readonly string[]; // tracks it went to (a note-off: those of its note-on; a pedal-up: those it was down on)
  }
  ```
  Sustain is applied per track (`SustainGate`); the recorder closes a pending note at its note-off unless a `sustain`
  down event for that track is still open, then at the pedal-up. Controllers that drive a learned knob also arrive as
  `cc` events (the knob is turned first); `mappingsFor(engine.sequencer.midiMappings, cc, channel)` says which
  parameters, for recording CC into automation. `router.handle(input, parseMidiMessage(bytes), timeStamp)` plays a
  message as if it came in.
- **Tracks** (`LiveTrack`, implemented by `BaseTrack`): `noteOn(id, note, velocity, time)`, `noteOff(id, time)`,
  `setSustain(down, time)`, `setLiveBend(value, time)`, `allNotesOff(time)`, `liveNoteCount`; `isArmed` +
  `setArmed()` (transient: not in capture/serialize, not in history). The same id again restarts its note; a muted
  track counts the note but stays silent. Subclasses implement `startLiveNote`/`stopLiveNote`.
  - **Synth:** every live note gets an engine id (1, 2, ...). Cut mode keeps a `NoteStack`: the newest key wins, and
    when the sounding key comes up while others are held, the newest held one takes over (legato `noteOn`), then the
    released id gets its `noteOff` (a no-op, the voice already belongs to the new id). Changing cut/overlap or going
    to sleep releases every live note.
  - **Sample tracks:** one voice per note, started with an unknown length; gate keeps it until `noteOff` (the fade
    follows the stop), one-shot ignores `noteOff`. `cutsNotes` works as for pattern notes.
- **Rust ABI v3** (`crates/synth-worklet`, 18.8 KB): `note_on(frame, id, hz, velocity, duration_frames)`, where
  `duration_frames < 0` holds the note (`release_at = NEVER`, gate open) and `id` 0 is a scheduled note;
  `note_off(frame, id)` releases every held voice with that id (0 is rejected), queued and applied on its frame like
  every event; `set_param(frame, 5, semitones)` is the bend, which glides (one-pole, 4 ms) and is applied per sample
  only while it glides (frequency = note hz × 2^(bend/12)), so a settled bend costs nothing per sample. A note
  started under a bend starts bent. Voices keep `id`, their own `hz` and a `gate` flag (stealing "released first" now
  reads the gate). Protocol: `{ type: 'note', id, duration: -1 }` and `{ type: 'noteOff', time, id }`;
  `SynthEvents.noteOn/noteOff`, `SynthParam.bend = 5`, `SYNTH_ABI = 3`.
- **Tone engine:** `noteOn` → `triggerAttack`, `noteOff` → `triggerRelease` (mono: only when the id is the one
  sounding; poly: by note). Bend → `detune` in cents with a 10 ms ramp (the PolySynth's voices are reached through its
  private `_voices`, and `options.detune` for voices made later).
- **Bend parameter.** `SynthTrack.bend` (-1..1 of `bendRange`, the knob; automation key `bend`, group Synth) and
  `bendRange` (1..24 semitones, default 2, buttons ±1/2/3/5/7/12/24); both saved (optional in older states). Stored as
  a fraction so one parameter table serves every range. The wheel adds to the knob (`bend + wheel`, clamped to ±1),
  so the centre gives the knob's bend back; automation sets it absolutely, as for every parameter.
- **Hibernation.** The router wakes the container of every track it plays a note on (`Sequencer.wakeForLive`), and
  while any of its tracks holds a live note the container counts as due on every step; afterwards it sleeps as usual.
- **MIDI learn.** `SessionState.midiMappings?: MidiMapping[]` (`{ cc, channel: 0..15 | 'all', target, param }`),
  held by the sequencer (`setMidiMappings`), captured, restored and saved in the file (format stays 2: the field is
  optional). Learning stores the channel heard; the list switches a mapping to "any ch" and back. One controller per
  parameter and one parameter per controller (`learnMapping` drops the others). A mapped CC sets the stored value
  through `setParameter` (tracks via their reactive proxy) and pulses `paramChange`, which knobs with their own copy
  (effects, buses) follow. History: `useHistory().commitWhenQuiet()` holds commits while the controller moves and
  commits once 400 ms after the last message, so a gesture is one undo step (undo/redo flush it). In learn mode the
  knobs with a `learn` owner get a dashed ring, the picked one pulses, mapped ones show "CC n"; Escape leaves.
  Learnable: synth envelope and bend, every automatable effect knob (tracks, container, master), bus level and pan.
- **Latency.** `latency.ts` reads `localStorage['juicyloops:lowLatency']` (default on) when `engine.ts` loads:
  `ENGINE_LATENCY_HINT` is `'interactive'` or `'balanced'` (before this it was always `'balanced'`). `lookAhead` stays
  0.2 s. The popover's switch notes "takes effect the next time you start" when it differs from the running context.
- **Web MIDI.** `requestMIDIAccess({ sysex: false })` from the "Enable MIDI" button; after the first click of a later
  session `restore()` asks again only when it was granted before and the Permissions API says `granted` (no dialog out
  of nowhere). Hot-plug through `statechange`; switched-off inputs are kept in `localStorage['juicyloops:midiDisabled']`
  by id and by name.
- **Verified** (`node scripts/midi/live.mjs`, 72 checks, all pass; Chromium 153 headless, dev server without HMR):
  - Rust engine (secure-origin flag) and the Tone engine (the same secure page, and the real fallback on the insecure
    origin via the headless shell, checked with an AnalyserNode): note-on sounds in the next render callback (first
    non-zero sample 1 frame after the frame the context was at when the message arrived; worst case one device
    callback when the message just missed one), note-off releases, sustain holds a released key until pedal-up, bend
    +1 = +2 semitones and -0.5 = -1 semitone measured by zero crossings, last-note priority and the fallback to the
    held key, silent after the last key.
  - UI: Enable MIDI lists the fake keyboard; learn highlights the knobs, a click then CC 74 maps Attack; CC 127 turns it
    to 2 s and the knob follows; a stream of 18 CC messages is one history entry and undo takes it back; mappings are
    in the captured state; a reload brings MIDI back by itself.
  - Sampler: keys 72..75 play slices 1..4 (220/330/440/660 Hz), one-shot plays on after the note-off, gate stops it
    (keys 60..63 before the standard-pitch change).
  - Hot-plug: a new input is listed and plays; unplugging it stops its held note; a switched-off input is ignored and
    remembered. A note on an armed track in a sleeping container wakes it (sounds 1 frame after the event) and it stays
    awake while the key is held with the loop playing.
- **Latency** (event to first non-silent sample at the master bus; 12 notes each; headless Chromium, 44.1 kHz):

  | hint | engine | onset after the event (median / max) | rendered, wall clock (median / max) | baseLatency |
  |---|---|---|---|---|
  | interactive | Rust | 0.02 / 0.02 ms | 7.0 / 12.3 ms | 11.6 ms |
  | interactive | Tone | 0.02 / 23.2 ms | 7.2 / 26.5 ms | 11.6 ms |
  | balanced | Rust | 0.02 / 20.3 ms | 6.6 / 22.7 ms | 10.0 ms |
  | balanced | Tone | 0.02 / 0.05 ms | 6.9 / 22.7 ms | 10.0 ms |

  Both engines start a live note on the first frame the audio thread renders after the message; the engine adds no
  latency. What the hint changes is the device buffer, and headless Chromium's fake output device ignores it (it
  renders 1024 frames per callback, outputLatency 32 ms, for both hints), so the difference between 'interactive' and
  'balanced' cannot be measured here; on real hardware it is the difference in `baseLatency + outputLatency`
  (typically ~10 ms vs ~20-40 ms). The maxima are a message that just missed a callback.

---

## Phase 4: Recording

- **Transport:**
  - A **Record** button (and the `R` key) next to play/stop.
  - Toggles for **replace** (off means overdub), **count-in** (1 bar) and **metronome**. The toggles are saved
    in localStorage.
  - Recording needs at least one armed track, or a selected one.
- **Timing, from what the player heard to a pattern position.**
  - A MIDI event carries `timeStamp` in the `performance.now()` clock.
  - `context.getOutputTimestamp()` gives the context time that was being heard at a performance time. The event
    therefore maps to the context time *heard* when the key went down.
  - The transport converts that time to ticks, then to a song step and a pattern position: in loop mode the
    running step wrapped by the track's length; in song mode the clip-relative pattern step of the armed
    track's container, via `song.playingAt`. When the container is not playing at that point, the note is
    played live but not recorded.
  - A **record offset** setting (± ms, default 0) allows manual calibration.
  - Pure functions in `midi/recordTiming.ts` with unit tests.
- **Takes.**
  - Note-on opens a pending note. Note-off (or pedal-up for held notes) closes it with the length it was held.
  - Pressing stop closes every open note at the stop time.
  - A note held across the loop end keeps its full length, and its tail rings across the wrap.
  - Notes are added to the track as they close, so they show up in the roll while recording.
  - Timings are not quantized.
- **Overdub** adds notes on every pass.
- **Replace:**
  - During the first pass of a take, the step callback removes notes that start inside the stretch the playhead
    has just passed, but only on armed tracks.
  - Later passes of the same take overdub.
- **Count-in** plays one bar of metronome clicks before the transport starts, and recording begins at the
  transport start.
- **Metronome:**
  - A short click (accented on the downbeat), made by a small dedicated synth or buffer that is routed straight
    to the destination, not through the master. So it never ends up in exports, and offline renders never create
    it.
  - It clicks during the count-in and while recording when enabled. An optional "metronome while playing"
    toggle is also available.
- **CC and pitch bend recording** go into the armed track's step automation lanes:
  - Points land at fractional step positions. They are thinned: a point is only kept when the value changed by
    more than 0.5 % or 1/64 step has passed, and at most 16 points per step.
  - A lane for the parameter is created when needed. `replace` clears the passed stretch of those lanes as well.
  - `BaseTrack.applyAutomation` gains sub-step resolution: for the step window it schedules `linearRampTo` to
    every point inside the window, not only the value at the start of the step. The song lanes follow the same
    rule.
- **History:** a whole take (from record start to stop) is one undo step. Capture happens at record start;
  intermediate edits during recording are not pushed.
- **Tests:**
  - Unit: timing conversion (loop, song and not-playing cases, latency and offset), take assembly (overlap,
    sustain, stop closes notes, wrap), replace clearing and CC thinning.
  - Playwright with fake MIDI: record 4 notes at known times in loop and in song mode. The recorded starts match
    what was played within ±3 ms after the output-latency mapping. Overdub adds, replace clears, count-in delays,
    the metronome is audible live and absent from exports, and undo removes the take.

**As built (Phase 4):**

- **Files.** Pure: `juicyloops/midi/recordTiming.ts` (time stamp → heard time → running step → pattern position),
  `midi/take.ts` (`Take`: notes of a take; `ReplacePass`, `notesToReplace`), `midi/laneRecord.ts` (controller thinning
  and writing points), `midi/recordSettings.ts` (the toggles in `localStorage['juicyloops:record']`),
  `juicyloops/metronome.ts`. Glue: `composables/useRecorder.ts` (module-level state). UI:
  `components/midi/RecordControls.vue` (button + options popover) in the transport of `JuicyLoops.vue`. Engine hooks:
  `Sequencer.setStepHook` (runs in the step callback before the step is scheduled; only the live engine's sequencer
  gets one), `engine.play(at?)` / `useJuicyLoops().play(at?)` (a transport start at a context time) and
  `onBeforeStop` (runs while the transport still knows where it was), `useHistory().hold(onBreak)` / `release()`,
  `BaseTrack.holdAutomation/releaseAutomation`, `automation.firstPointAfter`, `song.songStepAt` (shared with the
  sequencer). Tests: `recordTiming.spec.ts`, `take.spec.ts` (take assembly, replace, thinning, lane writing, sub-step
  point selection), `midiMessages.spec.ts` (the key mapping); browser: `frontend/scripts/midi/record.mjs` (the fake's
  `send(bytes, input, timeStamp)` now takes a time stamp).
- **Transport UX.** A Record button (red dot) right of play/stop, plus a chevron for the options: Replace (off =
  overdub, the default), Count-in (1 bar, on), Metronome (while recording, on), Metronome while playing (off), Record
  offset (±250 ms, default 0; positive moves recorded notes later). `R` (or the button) when stopped: count-in (the
  button shows the beat, amber), then the transport starts and the take with it (red, blinking); without count-in the
  transport starts at once (`now + lookAhead`). When playing: punch in at what is heard now. `R` again while recording
  punches out and playback goes on; during the count-in it cancels (stops). Space/stop ends the take and playback.
  With nothing armed and nothing selected a toast says "Nothing to record into". Switching loop/song view ends a take.
- **Timing.** `heardTime(timeStamp, clock, offsetMs)`: `getOutputTimestamp()` of the native context (behind Tone's
  wrapper: `_nativeAudioContext`) gives the context time at the output at a performance time; the event maps to
  `contextTime + (timeStamp - performanceTime) / 1000 + offset`. A stamp that is missing, zero, ahead of `currentTime`
  or more than 0.5 s behind is not trusted: then `currentTime - (baseLatency + outputLatency)` stands in. Then
  `transport.getTicksAtTime(heard) / (PPQ / 4)` is the running step (fractional; tempo changes included), and
  `patternPosition` wraps it by the track's length (loop mode, current container only) or goes through
  `songStepAt` (loop region, song end) and `Song.playingAt` to the clip-relative pattern step (song mode). No clip of
  the container there, another container in loop mode, or the transport not running: heard, not recorded. One
  addition: after a count-in, a note up to one step (a 16th) before the downbeat counts as played on it (players hit a
  downbeat a hair early); a punch-in has no such grace.
- **Takes.** A `Take` opens a note on every track the note-on went to (`trackIds`) and closes it at the note-off, or at
  the pedal-up while that track's pedal is down (the recorder tracks pedals all the time, so a take started under a
  held pedal knows it); a restrike under the pedal ends the old note where the new starts; stop/punch-out closes all.
  Lengths are measured in running steps, so a note held across the loop end keeps its length (its tail rings across
  the wrap), and notes are added (through the track's proxy) the moment they close, so they appear in the roll while
  recording. Note names come from `midiNoteName`, the same mapping the router plays.
- **Replace.** The step hook, just before a step is scheduled, removes the notes starting in that pattern step of each
  recording track (not those of the take), once per step: `ReplacePass` marks the steps, so the first full pass of a
  track (loop or song mode, any clip offset) replaces and later passes overdub. So on the first pass the old notes are
  not heard (they go just before they would play, ~0.2 s ahead of the playhead). Lanes the take records into lose
  the stretch the pass has cleared too (a lane that joins late loses what was passed already); lanes the take does not
  touch are left alone.
- **Controllers and the wheel.** Learned CCs are recorded when their mapping targets a record target the event went to
  (armed, or the selected one when none is armed; `recordTrackIds`, see "As built (selected track plays live)"): into that track's step lane for the parameter (value `toNormalized(controllerValue(...))`).
  The pitch wheel records into a synth track's `bend` lane (knob + wheel, clamped, i.e. what was heard). A lane is
  created on the first move, flat at the parameter's value when the take began. While a take records a lane, the lane
  does not play (`holdAutomation`), so the controller is heard, not the old curve; afterwards it plays again. Thinning
  (`ControllerThinner`): a value is kept when it moved by more than 0.5 % AND at least 1/64 step passed, at most 16 per
  step; a moved-but-dropped last value is written when the take ends. A gesture (points within a beat of each other)
  writes over the lane's old points between its points, also across the loop end ("touch"), instead of zig-zagging
  through them. **Holds** (`LaneWriter` in `midi/laneRecord.ts`, for step and song lanes alike): a gesture into a lane
  that has points takes over sharply, and the old curve around it stays as it was. Before its first point a `hold`
  point 1/256 step earlier (`HOLD_GAP`; two points cannot share a position) carries the lane's value there, so the old
  curve no longer ramps into the first recorded point; not needed where the segment holds already (a new song lane's
  start point), at position 0, in an empty lane. When the gesture ends (the next gesture of that lane starts, or the
  take ends) and old points follow it, a point 1/256 step after its last carries the old curve's value there, with the
  shape of the old segment it splits (worked out from the lane without the gesture plus the old points it wrote over),
  so the old curve goes on instead of ramping from the recorded end value into its next point; with nothing old after
  it the recorded end value holds, as before (so a new lane keeps the controller's last value). A gesture across a song
  loop region's end also gets a point at the region's end (the old curve after the region goes on), a hold before the
  region's start and a recorded point at the start with the value the gesture had at the wrap (the region starts
  where the gesture was; outside the region the song plays as it did). The holds are not the take's own points: a
  later gesture writes over them and replace clears them; replace mode puts none in a step it has cleared (no old
  curve left there: `ReplacePass.has` / `SongReplacePass.has`). Point limit: a hold in the first point's step counts
  towards its 16 (`ControllerThinner.reserve`), a hold into a step already holding 16 of the take's points is left out,
  and the hold after the gesture takes the place of the point before the last in a full step. Splitting a straight or
  holding segment is exact; a bent one (tension) stays close. Controllers mapped to a container channel, the master, or a track that is not armed: recorded into song
  lanes in song mode, played only in loop mode (see "As built (song-lane recording)" below).
- **As built (song-lane recording)** (the user's decision): in **song mode**, a learned controller whose mapping
  targets the master, a container bus or a track the event did not go to (not armed, not the selected fallback) records
  into the **song automation lane** for `(target, param)` (`songLaneFor` in `midi/laneRecord.ts`: the first lane with
  that target and parameter, else a new one via `Song.addAutomation`). Position: the song step heard
  (`recordTiming.songPosition`: `songStepAt` with the loop region / song-end wrap, as playback), whether or not a clip
  plays there; an empty song records nothing. A new lane gets a `hold` point at step 0 with the parameter's value when
  the take began, so the song sounds as before up to the first move (no ramp from the song start). Thinning, gesture
  overwrite and replace are the track lanes' (`ControllerThinner`, `writeRecordedPoint` with a `LaneWrap` so a gesture
  across the loop-region end only overwrites `(from, end) ∪ [start, to]`; `SongReplacePass` clears each song step once
  in the step hook, a late lane loses the steps already passed). While recorded, the song lane does not play
  (`Sequencer.holdSongAutomation`/`releaseSongAutomation`, which settles the parameter), nor does the target track's own
  step lane for that parameter. Same single undo step per take (`useHistory.release` now also flushes a pending
  `commitWhenQuiet`, so the controller stream's stored-value commit lands in the take's step at once instead of 400 ms
  later). The lanes appear in the song editor as they are created (reactive `song.automation`). Controllers aimed at an
  armed track keep recording into its step lanes (clip-relative). **Loop mode:** these controllers are only played (there
  is no song timeline); song lanes stay untouched. Also fixed: the resting value that `flush` hands back at the end of a
  take could make a 17th point in a full step; it now takes the place of that step's last point (`ControllerThinner.isFull`).
  An existing lane keeps its old curve up to the gesture and after it (the holds, see "Controllers and the wheel";
  this was a known limitation until the hold fix). Tests: `songLaneRecord.spec.ts` (also the holds: before, after,
  loop-region wrap, point limit, replace, new lane), `take.spec.ts` (the same for step lanes); `scripts/midi/record.mjs`
  now 55 checks (the holds: a CC gesture at steps 8..11 into a track's existing rising volume lane and one at song steps
  22..25 into the existing master lane leave the lane's values unchanged up to 1/256 step before the gesture and after
  it (drift ~1e-16), and an offline render matches the one before the take within 0.5 dB at steps before and after it;
  with the holds disabled these four checks fail with 4..35 dB ramps; the song CC check "points at the song steps heard"
  skips the two holds) (song CC: master volume, a container
  bus and an unarmed track into song lanes, thinned, at the song steps heard, the editor shows the lanes during and after
  the take, the old lane is silenced while recording (+6 dB heard vs -28 dB the lane would play; a run with the hold
  disabled fails this check), an offline song render follows the master sweep (-46 → -5 dB), one undo step and undo
  removes the points and the new lanes; a loop-mode take leaves the song lanes untouched).
- **Sub-step automation.** `BaseTrack.applyAutomation` and `Sequencer.applySongAutomation` apply the value at the step
  start (as before), then every point inside `(step, step + 1)` at its own time (`setParameter(key, value, time)`, a
  10 ms ramp like every automation move). `firstPointAfter` is a binary search; the loops allocate nothing.
- **Metronome.** Two tiny buffers (1760 Hz accent on the bar's downbeat, 1320 Hz beats), buffer sources into a gain
  node connected to the native context's destination: never through the master, never in an offline render (only the
  recorder's step hook and the count-in make clicks). Clicks follow the play position (`step % 4`, accent on
  `step % 16`: bars of the loop, or of the song). Clicks still ahead are cancelled on stop.
- **History.** `hold()` commits what came before, commits wait while the take runs (the shell's watcher keeps trying and
  gets `false`), `release()` at the end commits the whole take as one step. Undo, redo or a reset during a take end it
  first (punch out), then act.
- **Also fixed:** the shell committed history on every key-up, so releasing Alt in the middle of a piano-roll drag split
  it into two undo steps. Key-ups of modifier keys (Alt, Shift, Control, Meta, ...) no longer commit, nor does any
  key-up while a pointer is down; checked: a gesture with an Alt/Shift release in the middle is one history entry.
- **Standard pitch** (the user's decision): see "Note numbers" in "As built (Phase 3)"; `scripts/midi/live.mjs` expects
  it (rust 49/49 and tone 19/19 pass).
- **Verified** (`node scripts/midi/record.mjs`, 38 checks, all pass; Chromium headless with the Rust synth, dev server
  without HMR, 120 BPM, a step is 125 ms): the R key and the button (start, punch out, punch in, stop); four notes at
  steps 1, 4.5, 8.25, 12.75 in loop mode land exactly there (0.00 ms from the start derived from the fake's time stamp
  and `getOutputTimestamp()`, and from the intended step), lengths as held, names from `midiNoteName`, velocities kept;
  an offline render plays them at their starts (within 0.06 ms); one take = one history entry; overdub adds (one on the
  second pass); replace clears the first pass and overdubs the second; undo takes back replace, overdub and the first
  take one at a time (2 → 6 → 4 → 0 notes); a note held from step 14 to 19 keeps start 14 and length 5 and rings across
  the wrap in a render; sustain holds a note to the pedal-up; CC 74 learned to the track's volume records 98 thinned
  points (max 16 a step) from 193 messages, the lane starts at the take's level, and an offline render follows the sweep
  (-47 → -9 dB, rising step by step, including points between steps); the wheel records into `bend`; the count-in
  starts the transport 2.100 s after the press (one bar at 120 BPM + 0.1 s lead) with its clicks at the destination;
  the metronome is heard at the destination with the master turned all the way down, silent when off, and an offline
  export is silent (peak 0); a sampler records keys 72..75 as C5..D#5 at the stamped times and a render plays them there
  (within 0.11 ms); song mode records the four notes inside the clip at their clip-relative positions (pattern 1.25, 4,
  8.75, 10.5 from song steps 33.25, 20, 40.75, 26.5 with the clip at step 16) and not the one before the clip.
- **Accuracy.** The mapping itself adds no error (0.00 ms above: the recorder reads the same stamp the check derives its
  expectation from). What limits it is the output stamp itself: on headless Chromium's fake device (1024-frame
  callbacks, `outputLatency` 56 ms, `baseLatency` 11.6 ms) the audio clock runs 2.6 % slow against `performance.now()`
  and advances in bursts, so heard times extrapolated from successive stamps scatter around a straight line by -21 ..
  +13 ms (5th..95th percentile, 511 readings over 4 s). There a key lands within about a device callback of when it
  was heard; the checks above therefore stamp their messages from the stamp the app reads. On real hardware the stamp
  follows the device clock (a callback of 128..512 frames); the record offset corrects a constant error.

---

**As built (selected track plays live)** (the user's decision, after Phase 5):

- **Playing vs recording.** The router takes two lists (`MidiRouterOptions`): `live()`, the tracks that play (every armed
  track plus the selected one, once), and `recordTargets()`, the tracks a take records into (every armed track, or the
  selected one when none is armed; `useMidi().liveTracks` / `recordTargets`, `armedTracks` is gone). So a selected
  track that is not armed plays while other tracks are armed, but is not recorded. Every `MidiRouterEvent` carries
  `trackIds` (played) and `recordTrackIds` (those of them that record): a note-off keeps the record ids of its note-on,
  a pedal-up those the pedal went down on plus the current ones, all-notes-off those of the notes it stops. The recorder
  uses `recordTrackIds` for notes, sustain, all-notes-off, replace passes, the wheel and learned CCs; a CC aimed at a
  selected-but-unarmed track while others are armed goes to a song lane in song mode, like any unarmed track. The
  recorder's own pedal state per track still follows `trackIds` (the pedal is physical). `beginTake`/`canRecord` use
  `recordTargets()`. Changing the selection during a held key: the note-off still reaches the tracks the note-on went
  to (the router remembers them), so nothing hangs. Arm hints and the MIDI popover say so.
- **Tone engine fix.** Two live keys in the same render quantum on the Tone fallback in cut mode started its one voice
  twice at the same context time, which Tone rejects with a throw; the later key now starts one sample later
  (`ToneSynthEngine.noteOn`). Found by the roll checks below.
- **Live key lighting in the piano roll.** `SustainGate` keeps each live note's name and gives `keys()`: note name →
  `'held'` or `'sustained'` (the pedal holds it). `BaseTrack` publishes that to `midi/heldKeys.ts` on every live
  note-on/off, pedal and all-notes-off (never per frame, never for pattern notes): a `shallowReactive` Map by track id,
  whose entries are replaced (and skipped when equal), so a reader depends on its own track only. `roll/RollLiveKeys.vue`
  (twice in `PianoRoll.vue`: `part="keys"` in the key column next to the memoized keys, `part="rows"` under the note
  bars) maps names through the roll's `rowOf` (a sample roll lights the slice the key plays, clamped like
  `sliceIndexOf`; a whole sample the key's row) and draws the key in the track accent with its label, plus a faint band
  across the row; pedal-held keys dimmer (`[data-state='sustained']`, CSS in `globals.css`). Only this component
  re-renders on a key; the note bars do not (checked with a MutationObserver: 0 mutations).
- **Verified.** vitest (router split: live/record ids for notes, pedal, CC, wheel, all-notes-off, selection change under
  a held key; `SustainGate.keys`; per-track reactivity of the held-keys store). `scripts/midi/live.mjs` 78 checks (new:
  armed A + selected B both sound and release, a key held across a selection change releases on both, a new key after
  the change plays on A only, nothing armed: the selected track alone, pedal + selection change leaves nothing hanging;
  measured per track with analysers on the track outputs. The sleeping-container wake check mutes the selected track,
  which now plays too). `scripts/midi/record.mjs` 59 checks (new: armed A + selected B, only A records; a selection
  change under a held key, A records its full length; nothing armed, the selected track records; the song CC check's
  unarmed track is now explicitly the selected one). New `scripts/midi/rollKeys.mjs` (17 checks, `--shots <dir>` for
  dark/light desktop and phone screenshots): note-on lights key and row, note-off clears, sustain dims until pedal up,
  pattern playback lights nothing, the sampler roll lights the slice (a key past the last slice lights the last).

---

## Phase 5: Integration and performance check

- **Full check:** vue-tsc (app and vitest), eslint, vitest, `bash dsp/scripts/test.sh` and `check.sh`, and a
  production build with prerender.
- **Perf:** `node scripts/perf/run.mjs midi --compare scripts/perf/results/tier2-2.json`. The perf fixtures move
  to notes, but must stay equivalent. The step callback with bucketed notes must not cost more than the ticks
  did.
- **Docs:** update `notes/performance-upgrade.md` where it mentions ticks, and add a short "how to record"
  section to the in-app help if one exists.

**As built (Phase 5):** every check green with no fixes needed (vue-tsc app and vitest, eslint, vitest 226 tests,
`dsp/scripts/test.sh` and `check.sh`, build + SSR build + prerender); `scripts/midi/live.mjs` 72/72 and
`record.mjs` 38/38 still pass. The perf harness gained `--latency interactive|balanced` and times the step callback;
the bucketed notes cost the same as the ticks did (measured against 7315b50), and 'interactive' costs nothing
measurable on `heavy`. Numbers: "Notes instead of ticks" in `notes/performance-upgrade.md`. There is no in-app help
page; the status bar's key hints already list `R record`.

## Order and parallelism

1. Phase 1 on its own: everything compiles only once it is done.
2. Phases 2 and 3 in parallel (piano roll components versus the MIDI, engine and Rust code).
3. Phase 4 builds on both.
4. Phase 5.

Nothing is committed; the user reviews the working tree.
