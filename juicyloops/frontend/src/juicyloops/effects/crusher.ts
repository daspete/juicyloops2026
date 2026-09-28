import { CrossFade, Gain, ToneAudioNode, WaveShaper, type Signal } from 'tone';

/** Points in the staircase curve: 2^16 intervals over -1..1 plus the end point. */
const CURVE_LENGTH = 65537;

const MIN_BITS = 1;
const MAX_BITS = 16;

const clampBits = (bits: number): number => Math.min(MAX_BITS, Math.max(MIN_BITS, Math.round(bits)));

/**
 * The staircase for a bit depth, quantizing like Tone's BitCrusher worklet did: steps of 2^-(bits - 1), rounded to
 * the nearest step. The edges between levels fall between two curve points, so the waveshaper's interpolation
 * blurs each edge over 1/32768 of the range only.
 */
export const staircase = (bits: number): Float32Array => {
    const step = Math.pow(0.5, bits - 1);
    const curve = new Float32Array(CURVE_LENGTH);
    for (let i = 0; i < CURVE_LENGTH; i++) {
        const x = (i / (CURVE_LENGTH - 1)) * 2 - 1;
        curve[i] = step * Math.floor(x / step + 0.5);
    }
    return curve;
};

/**
 * Reduces the bit depth of the signal, like Tone's BitCrusher, but with a native WaveShaperNode instead of a
 * JavaScript AudioWorklet: the curve is a staircase of 2^bits levels, rebuilt when `bits` changes. `bits` is a plain
 * number, not sample-accurately automatable (Tone's worklet read it once per block as well).
 *
 * `wet` is a dry/wet crossfade like the one of Tone's effects, so the rack's mix control works as on every other effect.
 */
export class Crusher extends ToneAudioNode {
    readonly name = 'Crusher';

    readonly input: Gain;
    readonly output: CrossFade;
    /** The mix: 0 is only the dry signal, 1 only the crushed one. */
    readonly wet: Signal<'normalRange'>;

    private readonly shaper: WaveShaper;
    private currentBits: number;

    constructor(bits = 8) {
        super();
        this.currentBits = clampBits(bits);
        this.input = new Gain({ context: this.context });
        this.output = new CrossFade({ context: this.context, fade: 1 });
        this.shaper = new WaveShaper({ context: this.context, mapping: staircase(this.currentBits), length: CURVE_LENGTH });
        this.wet = this.output.fade;

        this.input.fan(this.output.a, this.shaper);
        this.shaper.connect(this.output.b);
    }

    get bits(): number {
        return this.currentBits;
    }

    set bits(bits: number) {
        const next = clampBits(bits);
        if (next !== this.currentBits) {
            this.currentBits = next;
            this.shaper.curve = staircase(next);
        }
    }

    override dispose(): this {
        super.dispose();
        this.input.dispose();
        this.shaper.dispose();
        this.output.dispose();
        return this;
    }
}
