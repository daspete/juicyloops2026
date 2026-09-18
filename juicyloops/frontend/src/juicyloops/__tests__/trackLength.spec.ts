import { describe, expect, it } from 'vitest';
import { MAX_TRACK_LENGTH, MIN_TRACK_LENGTH, normalizeTrackLength, STEP_COUNT } from '../constants';
import { beatsOf } from '@/components/tracks/steps';

describe('track length', () => {
    it('snaps to whole beats inside the bounds', () => {
        expect(normalizeTrackLength(16)).toBe(16);
        expect(normalizeTrackLength(13)).toBe(12);
        expect(normalizeTrackLength(14)).toBe(16);
        expect(normalizeTrackLength(0)).toBe(MIN_TRACK_LENGTH);
        expect(normalizeTrackLength(1000)).toBe(MAX_TRACK_LENGTH);
        expect(normalizeTrackLength(Number.NaN)).toBe(STEP_COUNT);
    });

    it('groups steps by beat', () => {
        expect(beatsOf(8)).toEqual([
            [0, 1, 2, 3],
            [4, 5, 6, 7],
        ]);
        expect(beatsOf(6)).toEqual([
            [0, 1, 2, 3],
            [4, 5],
        ]);
        expect(beatsOf(STEP_COUNT)).toHaveLength(8);
    });
});
