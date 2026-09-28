import { Gain } from 'tone';
import { markRaw } from 'vue';
import type { AutomationParam } from '../automation';
import { shiftOctave, type NoteLength, type OscillatorType } from '../notes';
import { SynthTick } from '../ticks/SynthTick';
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

const ENVELOPE_PREFIX = 'envelope.';
const envelopeStage = (key: string): SynthEnvelopeParam | null => (key.startsWith(ENVELOPE_PREFIX) ? (key.slice(ENVELOPE_PREFIX.length) as SynthEnvelopeParam) : null);

export interface SynthTrackSnapshot extends TrackSnapshot {
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
}

export interface SynthTrackState extends TrackState {
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
}

/**
 * Plays a note on every active tick. Cutting notes (the default) plays them on one voice, so a new note takes over
 * from the one before; overlapping plays every note on a voice of its own, so long notes and release tails ring on.
 */
export class SynthTrack extends BaseTrack<SynthTick> {
    readonly type = 'synth';

    override cutsNotes = true;

    /** Where the synth goes; the effect chain starts here. */
    private readonly input = markRaw(new Gain());
    /** Every voice of the track (see `synthEngine.ts`). Null while the track sleeps. */
    private engine: SynthEngine | null = null;

    oscillatorType: OscillatorType = 'sine';

    envelope: SynthEnvelope = { ...DEFAULT_ENVELOPE };

    constructor(id?: string) {
        super(id);
        this.buildEngine();
        this.connectSource(this.input);
    }

    protected createTick(): SynthTick {
        return new SynthTick();
    }

    protected trigger(step: number, time: number): void {
        const tick = this.activeTick(step);
        if (tick) {
            this.engine?.triggerAttackRelease(tick.note, tick.duration, time, tick.volume);
        }
    }

    override setCutsNotes(cuts: boolean): void {
        super.setCutsNotes(cuts);
        this.engine?.setCutsNotes(cuts);
    }

    /** A sleeping track has no engine at all: its nodes would be processed even while silent. */
    override sleep(): void {
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
        const settings = { context: this.input.context, cutsNotes: this.cutsNotes, oscillatorType: this.oscillatorType, envelope: { ...this.envelope } };
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

    /** Applies one note length to every step of the track. Each tick keeps its own length otherwise. */
    setAllNoteLengths(length: NoteLength): void {
        for (const tick of this.ticks) {
            tick.duration = length;
        }
    }

    /** Sets one stage of the amplitude envelope, e.g. `setEnvelope('attack', 0.2)`. */
    setEnvelope(param: SynthEnvelopeParam, value: number, time?: number): void {
        this.engine?.setEnvelope(param, value, time);
        if (time === undefined) {
            this.envelope = { ...this.envelope, [param]: value };
        }
    }

    protected ownParameters(): readonly AutomationParam[] {
        return ENVELOPE_PARAMS;
    }

    getParameter(key: string): number {
        const stage = envelopeStage(key);
        return stage && stage in this.envelope ? this.envelope[stage] : super.getParameter(key);
    }

    setParameter(key: string, value: number, time?: number): void {
        const stage = envelopeStage(key);
        if (stage && stage in this.envelope) {
            this.setEnvelope(stage, value, time);
        } else {
            super.setParameter(key, value, time);
        }
    }

    /** Moves every note of the pattern up (`1`) or down (`-1`) by one octave. */
    shiftOctave(direction: 1 | -1): void {
        for (const tick of this.ticks) {
            tick.note = shiftOctave(tick.note, direction);
        }
    }

    async copyFrom(source: this): Promise<void> {
        await super.copyFrom(source);
        this.setOscillatorType(source.oscillatorType);
        for (const param of Object.keys(source.envelope) as SynthEnvelopeParam[]) {
            this.setEnvelope(param, source.envelope[param]);
        }
    }

    dispose(): void {
        this.disposeEngine();
        this.input.dispose();
        super.dispose();
    }

    capture(): SynthTrackState {
        return { ...super.capture(), oscillatorType: this.oscillatorType, envelope: { ...this.envelope } };
    }

    restore(state: TrackState): void {
        super.restore(state);
        const synth = state as SynthTrackState;
        this.setOscillatorType(synth.oscillatorType);
        for (const param of Object.keys(synth.envelope) as SynthEnvelopeParam[]) {
            this.setEnvelope(param, synth.envelope[param]);
        }
    }

    async serialize(): Promise<SynthTrackSnapshot> {
        return {
            ...(await super.serialize()),
            oscillatorType: this.oscillatorType,
            envelope: { ...this.envelope },
        };
    }
}
