import { Gain } from 'tone';
import { markRaw } from 'vue';
import type { AutomationParam } from '../automation';
import { NoteStack } from '../midi/liveNotes';
import type { OscillatorType } from '../notes';
import type { PatternNote } from '../notes/Note';
import type { LegacyTrackState } from '../notes/migrate';
import { BaseTrack, type TrackSnapshot, type TrackState } from './BaseTrack';
import { createSynthEngine, type SynthEngine, type SynthEnvelope, type SynthEnvelopeParam } from './synthEngine';

export type { SynthEnvelope, SynthEnvelopeParam } from './synthEngine';

export const DEFAULT_ENVELOPE: SynthEnvelope = { attack: 0.005, decay: 0.1, sustain: 0.3, release: 1 };

const seconds = (value: number) => (value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`);
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The envelope stages as knobs and automation see them. */
export const ENVELOPE_PARAMS: readonly (AutomationParam & { stage: SynthEnvelopeParam; hint: string })[] = [
    { key: 'envelope.attack', stage: 'attack', label: 'Attack', group: 'Synth', min: 0.001, max: 2, step: 0.001, curve: 'log', format: seconds, hint: 'How long the note takes to reach full volume' },
    { key: 'envelope.decay', stage: 'decay', label: 'Decay', group: 'Synth', min: 0.01, max: 2, step: 0.001, curve: 'log', format: seconds, hint: 'How long it takes to fall to the sustain level' },
    { key: 'envelope.sustain', stage: 'sustain', label: 'Sustain', group: 'Synth', min: 0, max: 1, step: 0.01, curve: 'linear', format: percent, hint: 'The level held while the note plays' },
    { key: 'envelope.release', stage: 'release', label: 'Release', group: 'Synth', min: 0.01, max: 4, step: 0.001, curve: 'log', format: seconds, hint: 'How long the tail rings out after the note ends' },
];

/** Semitones a full pitch bend reaches either way, unless the track says otherwise. */
export const DEFAULT_BEND_RANGE = 2;
/** The bend ranges the track settings offer. */
export const BEND_RANGES: readonly number[] = [1, 2, 3, 5, 7, 12, 24];
export const MAX_BEND_RANGE = 24;

const formatBend = (value: number) => (Math.abs(value) < 0.0005 ? '0' : `${value > 0 ? '+' : '−'}${Math.round(Math.abs(value) * 100)}%`);

/**
 * Pitch bend as knobs, automation and a MIDI wheel see it: -1..1 of the track's bend range (`bendRange`, semitones).
 * Stored as a fraction so one parameter table serves every track whatever its range.
 */
export const BEND_PARAM: AutomationParam & { hint: string } = {
    key: 'bend',
    label: 'Bend',
    group: 'Synth',
    min: -1,
    max: 1,
    step: 0.001,
    curve: 'linear',
    format: formatBend,
    hint: 'Pitch bend, as far as the bend range reaches either way',
};

const SYNTH_PARAMS: readonly AutomationParam[] = [...ENVELOPE_PARAMS, BEND_PARAM];

const ENVELOPE_PREFIX = 'envelope.';
const envelopeStage = (key: string): SynthEnvelopeParam | null => (key.startsWith(ENVELOPE_PREFIX) ? (key.slice(ENVELOPE_PREFIX.length) as SynthEnvelopeParam) : null);

export interface SynthTrackSnapshot extends TrackSnapshot {
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
    /** Missing in snapshots from before pitch bend: 0 and `DEFAULT_BEND_RANGE` then. */
    bend?: number;
    bendRange?: number;
}

export interface SynthTrackState extends TrackState {
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
    bend?: number;
    bendRange?: number;
}

/** A live note on the synth: its engine id (a number, the engines' `noteOn` id), note and velocity. */
interface LiveSynthNote {
    engineId: number;
    note: string;
    velocity: number;
}

/**
 * Plays the notes of its pattern, each for its length. Cutting notes (the default) plays them on one voice, so a new note takes over
 * from the one before; overlapping plays every note on a voice of its own, so long notes and release tails ring on.
 */
export class SynthTrack extends BaseTrack {
    readonly type = 'synth';

    override cutsNotes = true;

    /** Where the synth goes; the effect chain starts here. */
    private readonly input = markRaw(new Gain());
    /** Every voice of the track (see `synthEngine.ts`). Null while the track sleeps. */
    private engine: SynthEngine | null = null;

    oscillatorType: OscillatorType = 'sine';

    envelope: SynthEnvelope = { ...DEFAULT_ENVELOPE };

    /** The stored pitch bend (the knob), -1..1 of `bendRange`. Automation and the MIDI wheel play over it. */
    bend = 0;

    /** Semitones a full bend reaches either way. */
    bendRange = DEFAULT_BEND_RANGE;

    /** Live notes by their MIDI id. Raw: the track itself is reactive. */
    private readonly liveNotes = markRaw(new Map<string, LiveSynthNote>());
    /** Last-note priority in cut mode (see `NoteStack`). */
    private readonly liveStack = markRaw(new NoteStack<LiveSynthNote>());
    private nextEngineId = 1;

    constructor(id?: string) {
        super(id);
        this.buildEngine();
        this.connectSource(this.input);
    }

    protected trigger(note: PatternNote, time: number, duration: number): void {
        this.engine?.triggerAttackRelease(note.note, duration, time, note.velocity);
    }

    protected startLiveNote(id: string, note: string, velocity: number, time: number): void {
        const live: LiveSynthNote = { engineId: this.nextEngineId, note, velocity };
        // Whole numbers above 0 (0 is a scheduled note in the Rust engine), and within its u32.
        this.nextEngineId = this.nextEngineId >= 0x7fffffff ? 1 : this.nextEngineId + 1;
        this.liveNotes.set(id, live);
        if (this.cutsNotes) {
            this.liveStack.press(id, live);
        }
        this.engine?.noteOn(live.engineId, note, time, velocity);
    }

    protected stopLiveNote(id: string, time: number): void {
        const live = this.liveNotes.get(id);
        if (!live) {
            return;
        }
        this.liveNotes.delete(id);
        if (this.cutsNotes) {
            // Last-note priority: when the note that sounds comes up, the newest key still held takes over (legato).
            const next = this.liveStack.release(id);
            if (next) {
                this.engine?.noteOn(next.value.engineId, next.value.note, time, next.value.velocity);
            }
        }
        this.engine?.noteOff(live.engineId, time);
    }

    /** Every held note stops; none of them takes over from another on the way (cut mode). */
    override allNotesOff(time: number): void {
        this.liveStack.clear();
        super.allNotesOff(time);
    }

    /** The wheel plays on top of the stored bend (the knob), so the centre position gives the knob's bend back. */
    override setLiveBend(value: number, time: number): void {
        this.engine?.setBend(Math.min(1, Math.max(-1, this.bend + value)) * this.bendRange, time);
    }

    override setCutsNotes(cuts: boolean): void {
        // Held notes belong to the mode they started in.
        if (cuts !== this.cutsNotes) {
            this.allNotesOff(this.now);
        }
        super.setCutsNotes(cuts);
        this.engine?.setCutsNotes(cuts);
    }

    /** A sleeping track has no engine at all: its nodes would be processed even while silent. */
    override sleep(): void {
        this.allNotesOff(this.now);
        super.sleep();
        this.disposeEngine();
    }

    override wake(): void {
        super.wake();
        this.buildEngine();
    }

    override whenReady(): Promise<void> {
        return this.engine?.whenReady() ?? Promise.resolve();
    }

    /** Builds the engine with the stored mode, oscillator and envelope. */
    private buildEngine(): void {
        if (this.engine) {
            return;
        }
        const settings = {
            context: this.input.context,
            cutsNotes: this.cutsNotes,
            oscillatorType: this.oscillatorType,
            envelope: { ...this.envelope },
            bend: this.bend * this.bendRange,
        };
        const engine = createSynthEngine(settings, () => {
            // The worklet engine could not start: rebuild, which gives the Tone engine from now on.
            if (this.engine === engine) {
                this.disposeEngine();
                if (!this.isAsleep) {
                    this.buildEngine();
                }
            }
        });
        engine.connect(this.input);
        this.engine = engine;
    }

    private disposeEngine(): void {
        this.engine?.dispose();
        this.engine = null;
    }

    setOscillatorType(type: OscillatorType): void {
        this.engine?.setOscillatorType(type);
        this.oscillatorType = type;
    }

    /** Sets one stage of the amplitude envelope, e.g. `setEnvelope('attack', 0.2)`. */
    setEnvelope(param: SynthEnvelopeParam, value: number, time?: number): void {
        this.engine?.setEnvelope(param, value, time);
        if (time === undefined) {
            this.envelope = { ...this.envelope, [param]: value };
        }
    }

    /** Sets the pitch bend, -1..1 of the bend range. With a `time` it is only played (automation), not stored. */
    setBend(value: number, time?: number): void {
        const bend = Math.min(1, Math.max(-1, value));
        this.engine?.setBend(bend * this.bendRange, time);
        if (time === undefined) {
            this.bend = bend;
        }
    }

    /** How many semitones a full bend reaches either way (1..24). */
    setBendRange(semitones: number): void {
        this.bendRange = Math.min(MAX_BEND_RANGE, Math.max(1, Math.round(semitones)));
        this.engine?.setBend(this.bend * this.bendRange);
    }

    protected ownParameters(): readonly AutomationParam[] {
        return SYNTH_PARAMS;
    }

    getParameter(key: string): number {
        if (key === BEND_PARAM.key) {
            return this.bend;
        }
        const stage = envelopeStage(key);
        return stage && stage in this.envelope ? this.envelope[stage] : super.getParameter(key);
    }

    setParameter(key: string, value: number, time?: number): void {
        const stage = envelopeStage(key);
        if (key === BEND_PARAM.key) {
            this.setBend(value, time);
        } else if (stage && stage in this.envelope) {
            this.setEnvelope(stage, value, time);
        } else {
            super.setParameter(key, value, time);
        }
    }

    async copyFrom(source: this): Promise<void> {
        await super.copyFrom(source);
        this.setOscillatorType(source.oscillatorType);
        for (const param of Object.keys(source.envelope) as SynthEnvelopeParam[]) {
            this.setEnvelope(param, source.envelope[param]);
        }
        this.setBendRange(source.bendRange);
        this.setBend(source.bend);
    }

    dispose(): void {
        this.disposeEngine();
        this.input.dispose();
        super.dispose();
    }

    capture(): SynthTrackState {
        return { ...super.capture(), oscillatorType: this.oscillatorType, envelope: { ...this.envelope }, bend: this.bend, bendRange: this.bendRange };
    }

    restore(state: TrackState | LegacyTrackState): void {
        super.restore(state);
        const synth = state as SynthTrackState;
        this.setOscillatorType(synth.oscillatorType);
        for (const param of Object.keys(synth.envelope) as SynthEnvelopeParam[]) {
            this.setEnvelope(param, synth.envelope[param]);
        }
        this.setBendRange(synth.bendRange ?? DEFAULT_BEND_RANGE);
        this.setBend(synth.bend ?? 0);
    }

    async serialize(): Promise<SynthTrackSnapshot> {
        return {
            ...(await super.serialize()),
            oscillatorType: this.oscillatorType,
            envelope: { ...this.envelope },
            bend: this.bend,
            bendRange: this.bendRange,
        };
    }
}
