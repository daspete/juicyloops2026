import { describe, expect, it } from 'vitest';
import { SampleTick } from '../ticks/SampleTick';
import { SynthTick } from '../ticks/SynthTick';

describe('ticks', () => {
    it('clones with the same class and values', () => {
        const tick = new SynthTick();
        tick.isActive = true;
        tick.note = 'G3';
        tick.volume = 0.5;

        const copy = tick.clone();

        expect(copy).toBeInstanceOf(SynthTick);
        expect(copy).not.toBe(tick);
        expect(copy.serialize()).toEqual(tick.serialize());
    });

    it('serializes its own fields', () => {
        const tick = new SampleTick();
        tick.pitch = 3;

        expect(tick.serialize()).toEqual({ isActive: false, volume: 1, pitch: 3 });
    });
});
