import { Gain, PanVol, type ToneAudioNode } from 'tone';
import { PARAM_RAMP_TIME } from './constants';
import { Effects } from './effects/effects';

/**
 * A summing stage with its own effect rack and volume/pan: `input -> effects -> output`.
 *
 * Every track container has one (all its tracks feed into it) and the song has one as the master channel
 * (all containers feed into it). The class is plain audio, the UI shows it through `BusRack`.
 */
export class MixBus {
    /** Where the sources connect to. */
    readonly input: ToneAudioNode = new Gain();

    readonly effects = new Effects();

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

    setVolume(volume: number): void {
        this.output.volume.rampTo(volume, PARAM_RAMP_TIME);
        this.volume = volume;
    }

    setPan(pan: number): void {
        this.output.pan.rampTo(pan, PARAM_RAMP_TIME);
        this.pan = pan;
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
