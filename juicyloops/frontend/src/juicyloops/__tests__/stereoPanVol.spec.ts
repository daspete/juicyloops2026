import { describe, expect, it } from 'vitest';
import { panGains } from '../stereoPanVol';

describe('stereo pan law', () => {
    it('matches the old mono panner for a source that is the same on both sides', () => {
        // Tone's PanVol folded to mono and panned with equal power: cos/sin of (pan + 1) · π/4.
        for (const pan of [-1, -0.5, 0, 0.3, 1]) {
            const theta = ((pan + 1) * Math.PI) / 4;
            const [left, right] = panGains(pan);
            expect(left).toBeCloseTo(Math.cos(theta), 10);
            expect(right).toBeCloseTo(Math.sin(theta), 10);
        }
    });

    it('keeps the power constant, −3 dB per side in the centre, and clamps', () => {
        for (const pan of [-1, -0.25, 0, 0.75, 1]) {
            const [left, right] = panGains(pan);
            expect(left ** 2 + right ** 2).toBeCloseTo(1, 10);
        }
        expect(panGains(0)[0]).toBeCloseTo(Math.SQRT1_2, 10);
        expect(panGains(1)[0]).toBeCloseTo(0, 10);
        expect(panGains(5)).toEqual(panGains(1));
    });
});
