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
        tick.note = 'D#5';

        expect(tick.serialize()).toEqual({ isActive: false, volume: 1, note: 'D#5' });
    });

    it('turns the semitone offset of old sample snapshots into a note above the root', () => {
        const tick = new SampleTick();
        tick.restore({ isActive: true, volume: 0.5, pitch: 3 } as never);

        expect(tick.serialize()).toEqual({ isActive: true, volume: 0.5, note: 'D#5' });
        expect('pitch' in tick).toBe(false);

        tick.restore({ isActive: true, volume: 1 } as never);
        expect(tick.note).toBe('C5');
    });
});
