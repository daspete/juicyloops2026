import { describe, expect, it } from 'vitest';
import { detectOnsets, evenCuts, MAX_SLICES, normalizeCuts, sliceRanges } from '../slices';

const RATE = 8000;

/** Silence with a decaying noise burst at each of `hits` (seconds). */
const drumLoop = (seconds: number, hits: number[], level = 0.8) => {
    const signal = new Float32Array(Math.round(seconds * RATE));
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (const hit of hits) {
        const start = Math.round(hit * RATE);
        for (let i = 0; i < RATE * 0.15 && start + i < signal.length; i++) {
            signal[start + i]! += noise() * level * Math.exp(-i / (RATE * 0.03));
        }
    }
    return signal;
};

describe('slices', () => {
    it('splits the region at the cuts inside it', () => {
        expect(sliceRanges(1, 3, [])).toEqual([{ start: 1, end: 3 }]);
        expect(sliceRanges(1, 3, [0.5, 2, 3.5])).toEqual([
            { start: 1, end: 2 },
            { start: 2, end: 3 },
        ]);
    });

    it('sorts cuts and merges the ones too close together', () => {
        expect(normalizeCuts([0.5, 0.2, 0.2001, -1, Number.NaN])).toEqual([0.2, 0.5]);
    });

    it('cuts into equal parts', () => {
        expect(evenCuts(0, 2, 4)).toEqual([0.5, 1, 1.5]);
        expect(evenCuts(0, 1, 1)).toEqual([]);
        expect(evenCuts(0, 1, 1000)).toHaveLength(MAX_SLICES - 1);
    });

    it('finds the hits of a drum loop, but not the start of the region', () => {
        const hits = [0, 0.25, 0.5, 0.875];
        const onsets = detectOnsets([drumLoop(1.2, hits)], RATE, 0, 1.2);
        expect(onsets).toHaveLength(3);
        onsets.forEach((onset, index) => expect(Math.abs(onset - hits[index + 1]!)).toBeLessThan(0.01));
    });

    it('only looks inside the region', () => {
        const onsets = detectOnsets([drumLoop(1.2, [0, 0.25, 0.5, 0.875])], RATE, 0.3, 0.8);
        expect(onsets).toHaveLength(1);
        expect(Math.abs(onsets[0]! - 0.5)).toBeLessThan(0.01);
    });

    it('finds nothing in silence', () => {
        expect(detectOnsets([new Float32Array(RATE)], RATE, 0, 1)).toEqual([]);
    });
});
