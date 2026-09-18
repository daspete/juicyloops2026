import { Synth } from 'tone';
import { markRaw } from 'vue';
import { atTime, type AutomationParam } from '../automation';
import { shiftOctave, type NoteLength, type OscillatorType } from '../notes';
import { SynthTick } from '../ticks/SynthTick';
import { BaseTrack, type TrackSnapshot, type TrackState } from './BaseTrack';

/** Amplitude envelope of the synth voice. Times are seconds, sustain is a level between 0 and 1. */
export interface SynthEnvelope {
    attack: number;
    decay: number;
    sustain: number;
    release: number;
}

export type SynthEnvelopeParam = keyof SynthEnvelope;

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

export class SynthTrack extends BaseTrack<SynthTick> {
    readonly type = 'synth';

    private readonly synth = markRaw(new Synth());

    oscillatorType: OscillatorType = 'sine';

    envelope: SynthEnvelope = { ...DEFAULT_ENVELOPE };

    constructor(id?: string) {
        super(id);
        this.synth.set({ envelope: this.envelope });
        this.connectSource(this.synth);
    }

    protected createTick(): SynthTick {
        return new SynthTick();
    }

    protected trigger(step: number, time: number): void {
        const tick = this.activeTick(step);
        if (tick) {
            this.synth.triggerAttackRelease(tick.note, tick.duration, time, tick.volume);
        }
    }

    setOscillatorType(type: OscillatorType): void {
        this.synth.oscillator.type = type;
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
        atTime(time, () => {
            this.synth.envelope[param] = value;
        });
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
        this.synth.dispose();
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
