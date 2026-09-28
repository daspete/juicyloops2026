import { describe, expect, it } from 'vitest';
import { staircase } from '../effects/crusher';

/** What Tone's BitCrusher worklet computed for every sample. */
const toneBitCrusher = (input: number, bits: number): number => {
    const step = Math.pow(0.5, bits - 1);
    return step * Math.floor(input / step + 0.5);
};

describe('crusher curve', () => {
    it('spans -1..1 in 65537 points', () => {
        const curve = staircase(8);
        expect(curve).toHaveLength(65537);
        expect(curve[0]).toBe(-1);
        expect(curve[32768]).toBe(0);
        expect(curve[65536]).toBe(1);
    });

    it.each([1, 4, 8, 12, 16])('quantizes like Tone’s BitCrusher at %i bits', (bits) => {
        const curve = staircase(bits);
        for (let i = 0; i < curve.length; i += 7) {
            const x = (i / (curve.length - 1)) * 2 - 1;
            expect(curve[i]).toBeCloseTo(toneBitCrusher(x, bits), 6);
        }
        // Levels -1..1 in steps of 2^-(bits - 1): 2^bits + 1 of them, the curve's resolution permitting.
        expect(new Set(curve).size).toBe(Math.min(2 ** bits + 1, curve.length));
    });
});
