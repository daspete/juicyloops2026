import { Synth } from 'tone';
import { markRaw } from 'vue';
import { shiftOctave, type NoteLength, type OscillatorType } from '../notes';
import { SynthTick } from '../ticks/SynthTick';
import { BaseTrack, type TrackSnapshot } from './BaseTrack';

/** Amplitude envelope of the synth voice. Times are seconds, sustain is a level between 0 and 1. */
export interface SynthEnvelope {
    attack: number;
    decay: number;
    sustain: number;
    release: number;
}

export type SynthEnvelopeParam = keyof SynthEnvelope;

export const DEFAULT_ENVELOPE: SynthEnvelope = { attack: 0.005, decay: 0.1, sustain: 0.3, release: 1 };

export interface SynthTrackSnapshot extends TrackSnapshot {
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
}

export class SynthTrack extends BaseTrack<SynthTick> {
    readonly type = 'synth';

    private readonly synth = markRaw(new Synth());

    oscillatorType: OscillatorType = 'sine';

    envelope: SynthEnvelope = { ...DEFAULT_ENVELOPE };

    constructor() {
        super();
        this.synth.set({ envelope: this.envelope });
        this.connectSource(this.synth);
    }

    protected createTick(): SynthTick {
        return new SynthTick();
    }

    play(step: number, time: number): void {
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
    setEnvelope(param: SynthEnvelopeParam, value: number): void {
        this.synth.envelope[param] = value;
        this.envelope = { ...this.envelope, [param]: value };
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

    async serialize(): Promise<SynthTrackSnapshot> {
        return {
            ...(await super.serialize()),
            oscillatorType: this.oscillatorType,
            envelope: { ...this.envelope },
        };
    }
}
