# Studio layout concept: inspector, device rack, mixer rack, velocity lane

A plan for rebuilding the studio UI around a small set of fixed places, so every tool has one home and every
home works the same way for tracks, containers and the master. This is a concept only; the open questions at
the end need answers before any code is written. Paths are relative to `juicyloops/frontend/src/` unless noted.

## Where things are today

| Area | Today | What goes wrong |
|---|---|---|
| Tweak (`detail/DetailPanel.vue`) | 25rem dock on the left, three tabs: Sound, Pattern, Effects. | Sound, pattern tools and effects compete for one narrow column. Tabs hide each other, so you can't shape the sound while you watch the effects. It only shows tracks; containers and the master live in a different dock. |
| Effects (`effects/EffectRack.vue`) | All 12 effects are always in the chain as chips; an effect counts as "on" once it is no longer neutral (dry, 1:1, flat). One effect's knobs are shown at a time. | This isn't a rack: you can't add or remove effects, or bypass one without losing its settings, and you can't see two effects at once. Twelve chips are noise when two of them are doing anything. |
| Mixer (`mix/MixPanel.vue`, `BusStrip.vue`) | 23rem dock on the right. The current container's channel sits above the master, each with two knobs and a compact effect rack. | There are no track channels (track volume lives in the track head), no faders, no meters, no mute or solo on buses and no overview of the other containers. It works like a settings panel, not like a mixer. |
| Velocity (`tracks/settings/StepValueLane.vue`) | 3.5rem bars, one per step. Drag across them to paint. | The bars are short and give no readout while you drag. There's no line or curve tool and no way to edit one bar relative to its value. A chord or an off-grid note shares one bar with its step. The piano roll has a separate velocity lane (`PianoRoll.vue`) with its own gestures. |

## Guiding principles

1. **One selection drives everything.** Click a track, a container bus, a song lane or the master, and the
   Inspector and the Device rack both switch to it. There's one "current channel", shown by the same glow
   everywhere (track head, mixer strip and device rack header).
2. **Signal flow reads left to right.** Instrument → effects → channel (level/pan) → container bus → master.
   The device rack and the mixer both draw it in that direction.
3. **Every channel has the same anatomy.** Track, container and master strips differ only in colour and in
   what feeds them, so you learn one strip and know all of them.
4. **Progressive disclosure, not separate apps.** Quick mode and Pro mode use the same layout. Quick hides
   depth (sends, full device parameters, lane channels), it doesn't hide places.
5. **Direct manipulation, always with a readout.** Every drag shows its value, double-click resets, right-click
   opens the actions for the thing under the pointer, and Shift drags fine.

## The layout

```
┌──────────────────────────── Transport bar (file · views · play/rec · position · tempo · undo · mode) ───────────────────────────┐
├────────┬───────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────┤
│Browser │                                                                                   │ Inspector  (context of selection)  │
│(B)     │                     Workspace: Tracks view  /  Song view                          │  ▸ Channel   name · colour · I/O   │
│        │                                                                                   │  ▸ Pattern   length · tools        │
│ samples│   track heads │ step grid / piano roll / waveform / automation                    │  ▸ Voice     cut/overlap · bend    │
│ presets│                                                                                   │  ▸ MIDI      arm · learn map       │
│        │                                                                                   │  (collapsible sections)            │
├────────┴──────────────── ═══ drag to resize ═══ ──────────────────────────────────────────┴────────────────────────────────────┤
│ Bottom dock   [ Devices ] [ Mixer ]                                             (tab; Ctrl+1 / Ctrl+2; ⤢ maximise; ▾ collapse) │
│                                                                                                                                │
│  Devices: ┌Instrument─┐ → ┌EQ────┐ → ┌Comp──┐ → ┌Delay─┐ → ┌ + ┐        ┃ channel: ▮▮ fader · pan · M S                   │
│           │ synth osc │   │curve │   │GR ▮▮ │   │ knobs│   │add│        ┃                                                 │
│           └───────────┘   └──────┘   └──────┘   └──────┘   └───┘        ┃                                                 │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
│ Status bar                                                                                                                      │
```

- **Browser (left)**: the sample browser stays as it is. It could later hold device presets and effect presets
  as extra tabs.
- **Workspace (centre)**: unchanged in role. The track heads lose the volume slider and gain a small
  meter, because level now has a real home in the mixer. The head keeps mute, solo, arm and the tool toggles.
- **Inspector (right)**: replaces the Tweak dock. It holds settings that aren't sound shaping: name,
  colour, pattern length and tools, the cut/overlap voice mode, the MIDI arm and learn map, and routing (sends and
  output) in Pro mode. Sections are collapsible accordions instead of tabs, so several stay open at once. For a
  container it shows container settings; for a song lane, lane settings.
- **Bottom dock**: a resizable panel with two tabs, like Ableton's Detail view or Bitwig's device panel.
  - **Devices**: the whole chain of the selected channel as a horizontal rack.
  - **Mixer**: every channel as a horizontal mixer rack.
  - It can collapse to a 2rem bar with the tab names, or be maximised to fill the workspace, which suits mixing.
- **Phone**: the bottom dock becomes a full-screen sheet from the bottom bar. The device rack scrolls horizontally
  one card at a time (snap scrolling), and the mixer shows 3 to 4 strips with horizontal swipe.

## Device rack (effects as a rack)

```
┌ Kick 1 ▸ chain ─────────────────────────────────────────────────── [Macro | Full] [⟲ reset chain] [☰ preset] ┐
│ ┌⏻ Sampler ────────┐  ┌⏻ EQ ─────────┐  ┌⏻ Compressor ─┐  ┌⏻ Reverb ─────┐  ┌───────┐              │
│ │ ~~waveform~~     │  │   ╭──╮       │  │  ▮▮▮ GR -3dB │  │  Mix  Decay  │  │   +   │  ► Channel   │
│ │ pitch  start  att│  │ Low Mid High │  │ Thr Rat Atk  │  │  ◯     ◯     │  │ Add   │    level ▮▮  │
│ │ ◯      ◯      ◯  │  │ ◯   ◯   ◯    │  │ ◯   ◯   ◯    │  │  Pre ◯       │  │ effect│    pan  ◯   │
│ └──────────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └───────┘              │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **The instrument is the first device.** Today's Sound tab (synth oscillator/envelope/bend; sampler
  sample, slicing, pitch/speed; microphone input) becomes the first card of a track's chain. Containers and the
  master start with their bus input instead.
- **The chain is a list of slots.** Effects are added from a "+" card with a categorised picker (Dynamics · EQ &
  Filter · Space · Modulation · Drive & Lo-fi). They can be removed, bypassed with ⏻ (the settings stay), dragged to
  reorder, Alt-dragged to duplicate, and dragged onto another channel's rack to copy.
  - This changes the model: `Effects` moves from "12 fixed effects, on when not neutral" to "ordered slots". Old
    sessions convert on load (every non-neutral effect becomes a slot, in its old order). The lazy node rule
    stays: a bypassed slot has no node.
- **Each card has two faces.**
  - *Macro* (the default in Quick mode): 2 to 3 big knobs with names a beginner understands, e.g. Reverb
    shows "Size" and "Amount".
  - *Full*: every parameter.
  - One toggle on the rack header flips all cards; the chevron on a card flips just that card.
- **Cards show what they do.** An EQ card draws its curve, the compressor shows gain reduction, a filter shows
  its cutoff and an LFO effect shows a moving dot at its rate. The power dot glows when the effect is active.
- **The channel strip ends the rack.** The level, pan, mute and solo of the selected channel sit at the right
  end, so the whole path of one channel is on one screen.
- **Automation and MIDI learn stay on the knobs.** Right-click a knob → Automate, Learn MIDI or Reset. An automated
  knob shows a ring in the lane colour.

## Mixer rack

```
┌ Container "Verse" ────────────────────────────────────┐┌ Container "Drop" ─────┐┌ Master ┐
│ Kick 1 │ Snare 2 │ Synth 3 │ Mic 4 ║  VERSE BUS  ║    ││ ▸ (folded: bus only)  ││ MASTER │
│ ▢ EQ   │ ▢ Comp  │ ▢ Chor  │       ║ ▢ Comp      ║    ││   DROP BUS            ││ ▢ Lim  │
│ ▢ Rev  │         │ ▢ Delay │       ║ ▢ EQ        ║    ││   ...                 ││        │
│ ─send─ │ ─send─  │ ─send─  │       ║             ║    ││                       ││        │
│  ◯pan  │  ◯pan   │  ◯pan   │ ◯pan  ║   ◯pan      ║    ││                       ││  ◯pan  │
│ ▮▯ ┃   │ ▮▯ ┃    │ ▮▮ ┃    │ ▯▯ ┃  ║  ▮▮ ┃       ║    ││                       ││ ▮▮ ┃   │
│ ▮▯ ┃   │ ▮▯ ┃    │ ▮▮ ┃    │ ▯▯ ┃  ║  ▮▮ ┃       ║    ││                       ││ ▮▮ ┃   │
│ -2.1dB │ 0.0dB   │ -6.0dB  │ -∞     ║  0.0dB      ║    ││                       ││ -0.3dB │
│ M S ●  │ M S ●   │ M S ●   │ M S ●  ║  M S        ║    ││                       ││  M     │
│ ▬Kick▬ │ ▬Snare▬ │ ▬Synth▬ │ ▬Mic▬  ║ ▬Verse▬     ║    ││                       ││▬Master▬│
└───────────────────────────────────────────────────────┘└───────────────────────┘└────────┘
```

- **Groups.** Each container is a group: its track strips, then its bus strip, with a thick divider. Groups fold
  down to the bus strip alone. The master is pinned to the right edge and never scrolls away.
- **Strip anatomy, top to bottom:**
  - colour cap and name
  - insert list: the active devices by name, click one to open it in the Device rack, "+" to add
  - sends (Pro, see the open questions)
  - pan knob
  - fader with a stereo peak/RMS meter, a peak-hold line and a clip LED
  - dB readout (double-click to type)
  - mute, solo and arm
  - name plate
- **Two strip widths.** Normal (~5.5rem) and narrow (~3rem: fader and meter only, name rotated), for large
  sessions.
- **Selection sync.** Clicking a strip selects that channel everywhere, and selecting a track in the workspace
  scrolls its strip into view.
- **Meters.** One analyser per *visible* strip, created lazily and removed when the dock is closed, so they cost
  nothing while the mixer is hidden. The perf budget from `notes/performance-upgrade.md` still applies. A single
  metering AudioWorklet that reports all channels in one message is the fallback if Tone `Meter` nodes turn out
  too costly.
- **Song lanes** have no audio today: a lane only holds clips, and a container's bus is shared by every lane that
  plays it. See the open questions for the options.
- **Quick mode** shows only the current container's tracks plus the master, without inserts or sends.

## Velocity lane (like the automation clips)

One shared `VelocityLane` component for the step grid and the piano roll, replacing `StepValueLane` for velocity
and the piano roll's own lane.

```
100% ┤ ●         ●               ●       ●     ← one stem per note, at the note's real start
 75% ┤ │    ●    │    ●     ●    │   ●   │        (a chord shows side-by-side stems; hover separates them)
 50% ┤ │    │    │    │     │    │   │   │
 25% ┤ │    │    │    │     │    │   │   │     guide lines at 25/50/75/100 %
     └─┴────┴────┴────┴─────┴────┴───┴───┴─    readout bubble while dragging: "Step 5 · 78 %"
      [✎ Draw] [╱ Line] [∿ Curve]   ⋯ Humanize · Randomize · Scale · Ramp · Accent every N · Reset
```

- **Stems instead of bars.** Each note gets a lollipop at its real start, so off-grid notes and chords each
  keep their own velocity. An empty step shows a faint ghost stem at the velocity a new note will get, which you
  can set by dragging the ghost.
- **Grab-and-drag changes one note relatively.** Press on a stem's head and drag vertically; the value moves by
  the drag distance rather than jumping to the pointer, the way automation points behave. Shift drags fine and
  double-click resets to 100%.
- **Tools (toolbar; hold a key to switch temporarily):**
  - *Draw* (default): freehand sweep, as today, but it interpolates between pointer events so a fast sweep
    doesn't skip notes.
  - *Line* (hold Alt): drag from A to B to set every note in between onto a straight ramp (crescendo or fade).
  - *Curve*: the same ramp with the bend handle from `AutomationCurve.vue` (curve or S-curve).
- **Selection aware.** With notes selected (piano roll, or a marquee in the lane itself), every tool only touches
  the selection. Dragging one stem of a selection moves all of them relatively.
- **Menu (right-click or ⋯):** Humanize ±n%, Randomize within range, Scale (compress or expand around the
  average), Ramp up/down, Accent every Nth step, Set all to…, Reset.
- **Size.** The lane is resizable by dragging its bottom edge (default ~6rem, remembered per session) and shows
  the value scale on the left in the track-head column.
- **Keyboard.** With a stem focused: ↑/↓ changes it by 1% (Shift: 10%), ←/→ moves to the next note.

## Quick vs Pro at a glance

| | Quick | Pro |
|---|---|---|
| Inspector | Channel + Pattern sections | + Voice, MIDI, Routing |
| Devices | Instrument + up to N effects, macro faces, curated effect list | All effects, full faces, presets |
| Mixer | Current container's tracks + master, fader/pan/mute/solo | All containers, bus strips, inserts, sends, (lanes), narrow strips |
| Velocity | Draw + Line, menu | + Curve, selection-scoped tools |

## Suggested order of work

1. **Velocity lane.** It stands alone, has the fastest payoff and shares code with the piano roll.
2. **Layout shell.** The bottom dock (resizable, tabbed), the Inspector replacing Tweak, and selection sync.
3. **Device rack.** The slot-based `Effects` model with migration, device cards with macro and full faces, and
   the instrument device.
4. **Mixer rack.** Track strips, container groups, master, meters and solo.
5. **Routing (optional).** Sends/returns and lane channels, depending on the answers below.

Each step ends with type-check, lint, unit tests, and a browser check in light, dark, tablet and phone layouts.

## Decisions (2026-09-28)

| Topic | Decision |
|---|---|
| Layout | Bottom dock (Devices / Mixer tabs, resizable, collapse, maximise) + Inspector on the right replacing Tweak. |
| Instrument | The synth/sampler/mic sound settings are the first card of the device rack. |
| Effect chains | Slots: add, remove, bypass, reorder; the same effect may appear more than once. Old sessions migrate on load; old automation keys (`fx.<effect>.<param>`) keep working because a migrated slot's id is its effect key. |
| Song lanes | Mixer strips with mute/solo only (no lane audio). |
| Track channels | One mixer strip per track, grouped under its container. |
| Sends | Two return buses (A, B) now, with a send knob on every track and container strip. |
| Mixer scope | All containers as foldable groups (current one unfolded). Track heads keep their volume slider, synced with the fader. |
| Solo | Session-wide, on tracks, containers and returns (lanes keep their own lane solo in the song). |
| Quick mode | Simple mixer (current container's tracks + master: fader, pan, mute, solo) and the device rack with macro faces. |
| Presets | Factory presets per device + user presets (browser storage). |
| Velocity | Full set: stems at the real note start, Draw / Line / Curve, relative drag, selection-aware, menu (humanize, randomize, scale, ramp, accent, set all, reset), resizable, shared with the piano roll. |
| Style / phone | Current juicy look; mixer and rack fully usable on phones (bottom sheet, swipe). |

## Implementation (2026-09-29)

| Part | Where |
|---|---|
| Effect slots, migration, per-slot automation keys | `juicyloops/effects/effects.ts` (`Effects.add/remove/moveTo/duplicate/setBypassed`, `slotsFromLegacy`, `ensureLegacySlots`), rack metadata and factory presets in `effects/definitions.ts` (`EFFECT_INFO`, `EFFECT_PRESETS`, `addedParams`) |
| Sends and returns | `juicyloops/sends.ts` (`Sends`, `send.0/1` params), returns A (reverb) and B (delay) in `Sequencer.returns`, asleep until something feeds them (`updateReturns`) |
| Mute / solo | `MixBus` gate (mute + `setSilenced`), `BaseTrack.isSolo/isSilenced`, `Sequencer.updateSolo` (session-wide, returns solo-safe), run from a `watchEffect` in `useJuicyLoops` |
| Layout state | `composables/useWorkspace.ts` (bottom dock tabs/height/maximise/face/narrow/folded, Inspector, channel selection) |
| Channel models | `composables/useChannels.ts` (one shape for track, container, return, master) |
| Meters | `composables/useMeter.ts` (one shared rAF loop, meters only while a strip is mounted) |
| UI | `components/dock/BottomDock.vue`, `devices/DeviceRack.vue`, `devices/InstrumentDevice.vue`, `effects/EffectDevice.vue`, `effects/EffectVisual.vue`, `mixer/MixerRack.vue`, `mixer/ChannelStrip.vue`, `mixer/ChannelFader.vue`, `inspector/InspectorPanel.vue`; styles in `assets/css/studio-rack.css` |
| Presets | `composables/usePresets.ts` (factory + user, localStorage, carried in session files, format version 3) |
| Velocity lane | `components/tracks/velocity/*`, `juicyloops/notes/velocityTools.ts`, `assets/css/velocity.css` |

Not done / deliberately left out: dragging a device onto another channel's rack (the dock shows one tab at a time; Copy/Paste in the device menu does it instead), marquee selection inside the step-grid velocity lane, typed amounts in the velocity menu.
