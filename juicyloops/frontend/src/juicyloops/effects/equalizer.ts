import { BiquadFilter, ToneAudioNode, type Param } from 'tone';

/** Where the low shelf ends and the high shelf starts; the mid band sits between them. Same bands as Tone's EQ3. */
const LOW_FREQUENCY = 400;
const HIGH_FREQUENCY = 2500;
const MID_FREQUENCY = Math.sqrt(LOW_FREQUENCY * HIGH_FREQUENCY);
/** A wide mid band, reaching roughly from one shelf to the other. */
const MID_Q = 0.5;

/**
 * A three band equalizer: low shelf, mid peak and high shelf, one after the other.
 *
 * Tone's EQ3 splits the signal into three bands and adds them back up. The split is not phase coherent, so the
 * bands partly cancel around the split points and a flat EQ3 swallows notes near 400 Hz by as much as 12 dB.
 * Filters in series have no such sum, and a shelf or peak at 0 dB lets the signal through untouched.
 *
 * `low`, `mid` and `high` are the band gains in dB, named like EQ3's so the effect rack drives either.
 */
export class Equalizer extends ToneAudioNode {
    readonly name = 'Equalizer';

    readonly input: BiquadFilter;
    readonly output: BiquadFilter;
    private readonly midBand: BiquadFilter;

    readonly low: Param<'decibels'>;
    readonly mid: Param<'decibels'>;
    readonly high: Param<'decibels'>;

    constructor() {
        super();
        this.input = new BiquadFilter({ context: this.context, type: 'lowshelf', frequency: LOW_FREQUENCY, gain: 0 });
        this.midBand = new BiquadFilter({ context: this.context, type: 'peaking', frequency: MID_FREQUENCY, Q: MID_Q, gain: 0 });
        this.output = new BiquadFilter({ context: this.context, type: 'highshelf', frequency: HIGH_FREQUENCY, gain: 0 });
        this.input.chain(this.midBand, this.output);

        this.low = this.input.gain;
        this.mid = this.midBand.gain;
        this.high = this.output.gain;
    }

    override dispose(): this {
        super.dispose();
        this.input.dispose();
        this.midBand.dispose();
        this.output.dispose();
        return this;
    }
}
