import { describe, expect, it } from 'vitest';
import { MAX_TRACK_LENGTH, MIN_TRACK_LENGTH, normalizeTrackLength, STEP_COUNT } from '../constants';
import { beatsOf } from '@/components/tracks/steps';
import { NotePattern } from '../notes/NotePattern';

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

    it('drops notes starting past a new end and keeps the tails of the others', () => {
        const pattern = new NotePattern(32);
        pattern.setNotes([
            { id: 'a', note: 'C5', start: 0, length: 1 },
            { id: 'b', note: 'D5', start: 14.5, length: 8 },
            { id: 'c', note: 'E5', start: 16, length: 1 },
            { id: 'd', note: 'F5', start: 31, length: 1 },
        ]);
        pattern.setLength(16);
        expect(pattern.length).toBe(16);
        expect(pattern.notes.map((note) => note.id)).toEqual(['a', 'b']);
        // The tail of b runs past the new end and rings across the wrap.
        expect(pattern.getNote('b')?.length).toBe(8);

        // Growing again leaves the new steps empty.
        pattern.setLength(24);
        expect(pattern.notes.map((note) => note.id)).toEqual(['a', 'b']);
        expect(pattern.notesStartingAt(20)).toEqual([]);

        pattern.setLength(13);
        expect(pattern.length).toBe(12);
    });
});
