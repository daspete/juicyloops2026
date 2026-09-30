import { Gain, Merge, Split, ToneAudioNode, Volume, type Param } from 'tone';

/**
 * Volume and pan of a channel (a track's end, a bus), in stereo.
 *
 * Tone's `PanVol` folds its input to one channel before panning, which made the whole mix mono. Here each side gets
 * its own gain on the equal-power law the old panner used: left × cos θ, right × sin θ, θ = (pan + 1) · π/4. A mono
 * source (or one that is the same on both sides) therefore sounds exactly as it did through `PanVol` at every pan
 * position, centre included (−3 dB per side); a stereo source keeps its image, and pan works as a balance.
 *
 * `input -> volume (up-mixes mono to two equal sides) -> split -> left/right gains -> merge = output`
 */
export class StereoPanVol extends ToneAudioNode {
    readonly name: string = 'StereoPanVol';

    readonly input: Volume;
    readonly output: Merge;

    /** Level in dB. */
    readonly volume: Param<'decibels'>;

    /** Pan, -1 (left) .. 1 (right). */
    readonly pan: { readonly value: number; rampTo(value: number, rampTime: number, time?: number): void };

    private readonly split: Split;
    private readonly left: Gain;
    private readonly right: Gain;

    constructor(volume = 0, pan = 0) {
        super({});
        this.input = new Volume({ context: this.context, volume });
        // A splitter reads its input as discrete channels, so a mono input would come out left only: the volume stage
        // takes two channels and up-mixes (speakers) first.
        this.input.channelCount = 2;
        this.input.channelCountMode = 'explicit';
        this.input.channelInterpretation = 'speakers';
        this.volume = this.input.volume;
        this.split = new Split({ context: this.context, channels: 2 });
        this.left = new Gain({ context: this.context, gain: panGains(pan)[0] });
        this.right = new Gain({ context: this.context, gain: panGains(pan)[1] });
        this.output = new Merge({ context: this.context, channels: 2 });
        this.input.connect(this.split);
        this.split.connect(this.left, 0, 0);
        this.split.connect(this.right, 1, 0);
        this.left.connect(this.output, 0, 0);
        this.right.connect(this.output, 0, 1);
        this.pan = balance(this.left, this.right, pan);
    }

    dispose(): this {
        super.dispose();
        this.input.dispose();
        this.split.dispose();
        this.left.dispose();
        this.right.dispose();
        this.output.dispose();
        return this;
    }
}

/** The pan control over the two side gains: remembers the value, ramps both gains to it. */
const balance = (left: Gain, right: Gain, initial: number): StereoPanVol['pan'] => {
    let value = initial;
    return {
        get value() {
            return value;
        },
        rampTo(next: number, rampTime: number, time?: number) {
            value = next;
            const [l, r] = panGains(next);
            left.gain.rampTo(l, rampTime, time);
            right.gain.rampTo(r, rampTime, time);
        },
    };
};

/** The gains of the left and right side for a pan (-1..1), on the equal-power law. */
export const panGains = (pan: number): [number, number] => {
    const theta = ((Math.min(1, Math.max(-1, pan)) + 1) * Math.PI) / 4;
    return [Math.cos(theta), Math.sin(theta)];
};
