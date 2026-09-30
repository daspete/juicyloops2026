import type { ToneAudioNode } from 'tone';
import { markRaw, toRaw } from 'vue';
import { createId } from '../audio';
import {
    createParameterTable,
    firstPointAfter,
    MIX_PARAMS,
    toNormalized,
    toValue,
    TrackAutomation,
    valueAt,
    type Automatable,
    type AutomationParam,
    type ParameterTable,
    type StepAutomationLane,
    type StepAutomationSnapshot,
} from '../automation';
import { PARAM_RAMP_TIME, STEP_COUNT } from '../constants';
import { Effects, type EffectsSnapshot, type LegacyEffectsSnapshot } from '../effects/effects';
import { SEND_PARAMS, sendIndexOf, Sends } from '../sends';
import { publishHeldKeys } from '../midi/heldKeys';
import { SustainGate } from '../midi/liveNotes';
import type { LiveTrack } from '../midi/router';
import { StereoPanVol } from '../stereoPanVol';
import { upgradeTrackState, type LegacyTrackState } from '../notes/migrate';
import type { PatternNote } from '../notes/Note';
import { NotePattern } from '../notes/NotePattern';
import type { TrackType } from './registry';

export interface TrackSnapshot {
    id: string;
    type: TrackType;
    /** Length of the pattern in steps. */
    length: number;
    /** Sorted by start. */
    notes: PatternNote[];
    volume: number;
    pan: number;
    automation: StepAutomationSnapshot[];
    /** Missing in states saved before the setting existed; the track type's default applies then. */
    cutsNotes?: boolean;
    /** Send levels (dB) to the returns. Missing in states from before the mixer rack. */
    sends?: number[];
    /** A name the user gave the track; empty (or missing) shows its type and number. */
    name?: string;
}

/** Everything about a track that history keeps: what `serialize` gives, minus decoded audio, plus what the user can change. */
export interface TrackState extends TrackSnapshot {
    isMuted: boolean;
    /** Missing in states from before solo. */
    isSolo?: boolean;
    effects: EffectsSnapshot | LegacyEffectsSnapshot;
}

/** Every parameter of a track type, in menu order and by key. Frozen, so Vue hands it out without proxying it. */
const PARAMETER_TABLES = new Map<unknown, ParameterTable>();

/** A tempo lookup that needs no allocation: the transport's BPM param. */
interface TempoSource {
    getValueAtTime(time: number): number;
}

/**
 * The last tempo lookup. Tone's `getValueAtTime` costs close to a microsecond, and in one step callback every track
 * of a context asks the same transport about the same time, so they share one lookup per step.
 */
const lastTempo: { source: TempoSource | null; time: number; stepSeconds: number } = { source: null, time: Number.NaN, stepSeconds: 0 };

/**
 * Common behaviour of every track: a pattern of notes (see `NotePattern`), an effect chain and a volume/pan stage
 * that feeds the container's bus.
 *
 * Every track has its own length. The sequencer hands every track the same running step,
 * and the track wraps it around its own pattern, so a 16-step track repeats twice per section
 * and a 48-step one stretches over one and a half.
 *
 * Every value that can be turned (level, pan, the effects, and whatever a subclass adds) is a parameter
 * automation can drive: step lanes on the track itself, and lanes on the song's timeline.
 *
 * Tone.js nodes are wrapped in `markRaw` so Vue's reactivity never proxies them
 * (they are expensive to proxy and rely on private state). Everything else on a track
 * is plain data and can be observed by the UI.
 */
export abstract class BaseTrack extends NotePattern implements Automatable, LiveTrack {
    readonly id: string;

    abstract readonly type: TrackType;

    readonly effects = markRaw(new Effects({ role: 'track' }));

    /** Step lanes: one value per step for every automated parameter, looping with the pattern. */
    readonly automation = new TrackAutomation(STEP_COUNT);

    /** Volume (dB) and pan (-1..1) stage at the end of the chain. */
    protected readonly output = markRaw(new StereoPanVol(0, 0));

    /** A name the user gave the track; empty shows its type and number. */
    name = '';

    volume = 0;
    pan = 0;
    isMuted = false;
    /** Solo is session-wide: while any channel is soloed, the others are silenced (see `Sequencer.updateSolo`). */
    isSolo = false;

    /** Set by the session's solo state: another channel is soloed. Plain, not reactive; the sequencer writes it on the raw track. */
    isSilenced = false;

    /** The sends to the returns, tapped after the fader. */
    readonly sends = markRaw(new Sends(this.output));

    /** Where `connectTo` sent the track. */
    private destination: ToneAudioNode | null = null;

    /** Whether a new note stops the one still sounding (cut) or plays on top of it (overlap). */
    cutsNotes = false;

    /** The transport's tempo, looked up once (see `secondsPerStepAt`). */
    private tempo: TempoSource | null = null;

    /**
     * Whether MIDI input plays this track (see `midi/router.ts`). Transient: not saved and not in history, so
     * undo never disarms a track.
     */
    isArmed = false;

    /** Live notes (MIDI) that sound, and the sustain pedal holding some of them. Raw: the track itself is reactive. */
    private readonly liveGate = markRaw(new SustainGate());

    constructor(id = createId()) {
        super(STEP_COUNT);
        this.id = id;
    }

    /** Changes the length of the pattern (see `NotePattern.setLength`). Automation lanes follow. */
    override setLength(length: number): void {
        super.setLength(length);
        this.automation.resize(this.length);
    }

    /** The position inside this pattern for a running step count. */
    stepOf(step: number): number {
        return ((step % this.length) + this.length) % this.length;
    }

    /**
     * Called by the sequencer for every step (on the raw track, never through Vue's proxy): applies the step's
     * automation, then schedules every note that starts in `[p, p + 1)`, where `p` is the step's position in the
     * pattern, at its exact offset inside the step. Allocates nothing: the notes come from the bucket index.
     */
    play(step: number, time: number): void {
        const position = this.stepOf(step);
        this.applyAutomation(position, time);
        if (this.isMuted || this.isSilenced) {
            return;
        }
        const notes = this.notesStartingAt(position);
        if (!notes.length) {
            return;
        }
        const stepSeconds = this.secondsPerStepAt(time);
        for (let i = 0; i < notes.length; i++) {
            const note = notes[i]!;
            this.trigger(note, time + (note.start - position) * stepSeconds, note.length * stepSeconds);
        }
    }

    /** Seconds one step (a 16th) lasts at `time`, from the tempo of the transport this track's context runs. */
    protected secondsPerStepAt(time: number): number {
        const tempo = (this.tempo ??= markRaw(this.output.context.transport.bpm));
        if (lastTempo.source !== tempo || lastTempo.time !== time) {
            lastTempo.source = tempo;
            lastTempo.time = time;
            lastTempo.stepSeconds = 15 / tempo.getValueAtTime(time);
        }
        return lastTempo.stepSeconds;
    }

    /** Plays one note at `time` (audio-context seconds) for `duration` seconds. */
    protected abstract trigger(note: PatternNote, time: number, duration: number): void;

    /* ---- live notes (MIDI), see `midi/router.ts` ---- */

    /** How many live notes sound, held by their key or by the sustain pedal. */
    get liveNoteCount(): number {
        return this.liveGate.size;
    }

    /**
     * Starts a live note at `time` (normally `context.currentTime`: live notes skip the look-ahead) and holds it until
     * `noteOff` with the same `id`. The same id again restarts the note. A muted track keeps count but stays silent.
     */
    noteOn(id: string, note: string, velocity: number, time: number): void {
        if (this.liveGate.press(id, note)) {
            this.stopLiveNote(id, time);
        }
        if (!this.isMuted && !this.isSilenced) {
            this.startLiveNote(id, note, velocity, time);
        }
        this.publishHeldKeys();
    }

    /** Releases a live note, unless the sustain pedal is down: then it rings until the pedal comes up. */
    noteOff(id: string, time: number): void {
        if (this.liveGate.release(id)) {
            this.stopLiveNote(id, time);
        }
        this.publishHeldKeys();
    }

    /** The sustain pedal: note-offs while it is down are held back and released when it comes up. */
    setSustain(down: boolean, time: number): void {
        for (const id of this.liveGate.pedal(down)) {
            this.stopLiveNote(id, time);
        }
        this.publishHeldKeys();
    }

    /** Releases every live note (a panic, an input that went away); the pedal state stays. */
    allNotesOff(time: number): void {
        for (const id of this.liveGate.clear()) {
            this.stopLiveNote(id, time);
        }
        this.publishHeldKeys();
    }

    /** Tells the piano roll which keys sound now (`midi/heldKeys.ts`); only on live note changes. */
    private publishHeldKeys(): void {
        publishHeldKeys(this.id, this.liveGate.keys());
    }

    /** Live pitch bend, -1..1. Only synths bend (by their own range); the value is played, not stored. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setLiveBend(value: number, time: number): void {}

    /** The live mod wheel, 0..1. Only synths with a patch use it (a modulation source); played, not stored. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setLiveModWheel(value: number, time: number): void {}

    /** Makes a live note sound. The track type decides how (a synth voice, a sample voice). */
    protected abstract startLiveNote(id: string, note: string, velocity: number, time: number): void;

    /** Stops a live note (its release, or a gate fade). Unknown ids are ignored. */
    protected abstract stopLiveNote(id: string, time: number): void;

    /** The audio-context time now, for changes that must reach live notes right away. */
    protected get now(): number {
        return this.output.context.currentTime;
    }

    /** Wires `source -> effects -> output`. Subclasses call this once with their sound source; `connectTo` decides where the output goes. */
    protected connectSource(source: ToneAudioNode): void {
        this.effects.connect(source, this.output);
    }

    /** Sends the track into a node (its container's bus), replacing where it went before. */
    connectTo(destination: ToneAudioNode): void {
        if (this.destination) {
            this.output.disconnect(this.destination);
        }
        this.destination = destination;
        this.output.connect(destination);
    }

    /** Where the sends go (the returns' inputs); the container passes them on. */
    setSendTargets(targets: readonly ToneAudioNode[]): void {
        this.sends.setTargets(targets);
    }

    /** The node meters read: after the fader. Connect to it, never disconnect it. */
    get meterSource(): ToneAudioNode {
        return this.output;
    }

    /**
     * Whether the track's container sleeps (see `hibernate.ts`): its effect nodes, and a synth's voices, are thrown
     * away until it wakes. Values set meanwhile are kept and applied on waking.
     */
    protected isAsleep = false;

    /** Frees the nodes the track only needs while it can be heard. Only once nothing it played can still sound. */
    sleep(): void {
        this.isAsleep = true;
        this.effects.suspend();
    }

    /** Builds what `sleep` threw away. */
    wake(): void {
        this.isAsleep = false;
        this.effects.resume();
    }

    /** Resolves once the track can sound. A track that loads audio in the background (a sample) waits for it here. */
    whenReady(): Promise<void> {
        return Promise.resolve();
    }

    /** With a `time` the level is only played, not stored (automation); see `settle`. */
    setVolume(volume: number, time?: number): void {
        this.output.volume.rampTo(volume, PARAM_RAMP_TIME, time);
        if (time === undefined) {
            this.volume = volume;
        }
    }

    setPan(pan: number, time?: number): void {
        this.output.pan.rampTo(pan, PARAM_RAMP_TIME, time);
        if (time === undefined) {
            this.pan = pan;
        }
    }

    toggleMute(): void {
        this.isMuted = !this.isMuted;
    }

    toggleSolo(): void {
        this.isSolo = !this.isSolo;
    }

    /** Arms or disarms the track for MIDI input. Disarming does not stop notes still held: their note-offs still arrive. */
    setArmed(armed: boolean): void {
        this.isArmed = armed;
    }

    setCutsNotes(cuts: boolean): void {
        this.cutsNotes = cuts;
    }

    /* ---- parameters and automation ---- */

    /** Everything automation can drive on this track: level, pan, sends, the type's own (see `ownParameters`), then every effect slot. */
    get parameters(): readonly AutomationParam[] {
        return [...this.parameterTable().list, ...this.effects.parameters];
    }

    /**
     * Parameters specific to a track type (a synth's envelope, ...). Must be the same for every track of the same
     * `parameterVariant`: the result is cached per variant.
     */
    protected ownParameters(): readonly AutomationParam[] {
        return [];
    }

    /** What `ownParameters` depends on: the track's class, unless a type's parameters change with its settings (a synth's model). */
    protected parameterVariant(): unknown {
        return this.constructor;
    }

    /** A parameter by its key. A map lookup: automation calls it for every lane on every step. */
    parameter(key: string): AutomationParam | undefined {
        return this.parameterTable().byKey.get(key) ?? this.effects.parameter(key);
    }

    private parameterTable(): ParameterTable {
        const variant = this.parameterVariant();
        let table = PARAMETER_TABLES.get(variant);
        if (!table) {
            table = createParameterTable([...MIX_PARAMS, ...SEND_PARAMS, ...this.ownParameters()]);
            PARAMETER_TABLES.set(variant, table);
        }
        return table;
    }

    getParameter(key: string): number {
        if (key === 'volume') {
            return this.volume;
        }
        if (key === 'pan') {
            return this.pan;
        }
        const send = sendIndexOf(key);
        if (send >= 0) {
            return this.sends.levels[send] ?? 0;
        }
        return this.effects.getParameter(key);
    }

    setParameter(key: string, value: number, time?: number): void {
        if (key === 'volume') {
            this.setVolume(value, time);
        } else if (key === 'pan') {
            this.setPan(value, time);
        } else if (sendIndexOf(key) >= 0) {
            this.sends.setLevel(sendIndexOf(key), value, time);
        } else {
            this.effects.setParameter(key, value, time);
        }
    }

    /** Puts the stored value of a parameter back on the sound, after automation moved it. */
    settle(key: string): void {
        this.setParameter(key, this.getParameter(key));
    }

    /** Puts every automated parameter of this track back to its stored value. */
    settleAll(): void {
        for (const lane of this.automation.lanes) {
            this.settle(lane.param);
        }
    }

    /** Adds a step lane for a parameter, flat at the parameter's current value, so the sound does not change until you draw. */
    addAutomation(key: string): StepAutomationLane | null {
        const param = this.parameter(key);
        return param ? this.automation.add(key, toNormalized(param, this.getParameter(key))) : null;
    }

    /**
     * Parameters whose lanes are being recorded (MIDI controllers, pitch bend): their lanes do not play meanwhile, so
     * the controller is heard, not the old curve ("touch"). Transient and raw; see `holdAutomation`.
     */
    private readonly heldLanes: Set<string> = markRaw(new Set<string>());

    /** Stops a parameter's lane from playing while it is recorded. */
    holdAutomation(key: string): void {
        toRaw(this).heldLanes.add(key);
    }

    /** Lets a held lane play again and puts the parameter back to its stored value until the lane's next step. */
    releaseAutomation(key: string): void {
        if (toRaw(this).heldLanes.delete(key)) {
            this.settle(key);
        }
    }

    /**
     * Applies the step lanes for the step window `[index, index + 1)` starting at `time`: the curve's value at the step,
     * then every point inside the window at its own time (recorded controller moves sit between steps). No allocation.
     */
    private applyAutomation(index: number, time: number): void {
        const lanes = this.automation.lanes;
        const held = this.heldLanes;
        let stepSeconds = 0;
        for (let l = 0; l < lanes.length; l++) {
            const lane = lanes[l]!;
            const param = this.parameter(lane.param);
            if (!param || (held.size && held.has(lane.param))) {
                continue;
            }
            const points = lane.points;
            const position = valueAt(points, index);
            if (position === null) {
                continue;
            }
            this.setParameter(lane.param, toValue(param, position), time);
            const end = index + 1;
            for (let i = firstPointAfter(points, index); i < points.length; i++) {
                const point = points[i]!;
                if (point.step >= end) {
                    break;
                }
                stepSeconds ||= this.secondsPerStepAt(time);
                this.setParameter(lane.param, toValue(param, point.value), time + (point.step - index) * stepSeconds);
            }
        }
    }

    /** Copies the pattern, effects, automation and settings of another track of the same type onto this one. */
    async copyFrom(source: this): Promise<void> {
        this.setLength(source.length);
        // New ids: a note belongs to one track.
        this.setNotes(source.notes.map((note) => ({ note: note.note, start: note.start, length: note.length, velocity: note.velocity })));
        this.stepNote = source.stepNote;
        this.stepLength = source.stepLength;
        this.effects.copyFrom(source.effects);
        this.automation.copyFrom(source.automation);
        this.setVolume(source.volume);
        this.setPan(source.pan);
        this.sends.restore(source.sends.levels);
        this.name = source.name;
        this.setCutsNotes(source.cutsNotes);
    }

    dispose(): void {
        this.sends.dispose();
        this.effects.dispose();
        this.output.dispose();
    }

    /* ---- history ---- */

    /** The track as history keeps it. Synchronous, and cheap: no audio is copied. */
    capture(): TrackState {
        return {
            id: this.id,
            type: this.type,
            length: this.length,
            notes: this.serializeNotes(),
            volume: this.volume,
            pan: this.pan,
            isMuted: this.isMuted,
            isSolo: this.isSolo,
            effects: this.effects.capture(),
            automation: this.automation.serialize(),
            cutsNotes: this.cutsNotes,
            sends: [...this.sends.levels],
            name: this.name,
        };
    }

    /**
     * Takes a captured state back. Notes that are still there keep their objects, so the grid does not re-render from
     * scratch. A state from before notes (ticks) is converted first.
     */
    restore(saved: TrackState | LegacyTrackState): void {
        const state = upgradeTrackState(saved);
        this.setLength(state.length);
        this.setNotes(state.notes);
        this.setVolume(state.volume);
        this.setPan(state.pan);
        this.isMuted = state.isMuted;
        this.isSolo = state.isSolo ?? false;
        this.name = state.name ?? '';
        this.sends.restore(state.sends);
        if (state.cutsNotes !== undefined) {
            this.setCutsNotes(state.cutsNotes);
        }
        this.effects.restore(state.effects);
        this.automation.restore(state.automation);
        // A rack from before slots dropped its idle effects; the ones this track's lanes drive come back.
        this.effects.ensureLegacySlots(state.automation.map((lane) => lane.param));
    }

    async serialize(): Promise<TrackSnapshot> {
        return {
            id: this.id,
            type: this.type,
            length: this.length,
            notes: this.serializeNotes(),
            volume: this.volume,
            pan: this.pan,
            automation: this.automation.serialize(),
            cutsNotes: this.cutsNotes,
            sends: [...this.sends.levels],
            name: this.name,
        };
    }
}
