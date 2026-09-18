import { Gain, PanVol, type ToneAudioNode } from 'tone';
import { MIX_PARAMS, type Automatable, type AutomationParam } from './automation';
import { PARAM_RAMP_TIME } from './constants';
import { EFFECT_PARAMS, Effects, type EffectsSnapshot } from './effects/effects';

export interface BusSnapshot {
    volume: number;
    pan: number;
    effects: EffectsSnapshot;
}

/**
 * A summing stage with its own effect rack and volume/pan: `input -> effects -> output`.
 *
 * Every track container has one (all its tracks feed into it) and the song has one as the master channel
 * (all containers feed into it). The class is plain audio, the UI shows it through `BusStrip`.
 */
export class MixBus implements Automatable {
    /** Where the sources connect to. */
    readonly input: ToneAudioNode = new Gain();

    readonly effects = new Effects();

    /** Everything automation can drive on a bus: level, pan and the effect rack. */
    readonly parameters: readonly AutomationParam[] = [...MIX_PARAMS, ...EFFECT_PARAMS];

    /** Volume (dB) and pan (-1..1) stage after the effects. */
    private readonly output = new PanVol(0, 0);

    volume = 0;
    pan = 0;

    constructor() {
        this.effects.connect(this.input, this.output);
    }

    /** Sends this bus into another node, replacing where it went before. */
    connectTo(destination: ToneAudioNode): void {
        this.output.disconnect();
        this.output.connect(destination);
    }

    /** Sends this bus straight to the speakers. */
    toDestination(): void {
        this.output.disconnect();
        this.output.toDestination();
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

    /** Puts the stored value of a parameter back on the sound, after automation moved it. */
    settle(key: string): void {
        this.setParameter(key, this.getParameter(key));
    }

    capture(): BusSnapshot {
        return { volume: this.volume, pan: this.pan, effects: this.effects.capture() };
    }

    restore(snapshot: BusSnapshot): void {
        this.setVolume(snapshot.volume);
        this.setPan(snapshot.pan);
        this.effects.restore(snapshot.effects);
    }

    getParameter(key: string): number {
        if (key === 'volume') {
            return this.volume;
        }
        if (key === 'pan') {
            return this.pan;
        }
        return this.effects.getParameter(key);
    }

    setParameter(key: string, value: number, time?: number): void {
        if (key === 'volume') {
            this.setVolume(value, time);
        } else if (key === 'pan') {
            this.setPan(value, time);
        } else {
            this.effects.setParameter(key, value, time);
        }
    }

    /** Copies the effect rack and the level settings of another bus. */
    copyFrom(source: MixBus): void {
        this.effects.copyFrom(source.effects);
        this.setVolume(source.volume);
        this.setPan(source.pan);
    }

    dispose(): void {
        this.effects.dispose();
        this.input.dispose();
        this.output.dispose();
    }
}
