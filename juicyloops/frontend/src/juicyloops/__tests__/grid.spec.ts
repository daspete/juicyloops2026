import { describe, expect, it } from 'vitest';
import { GRIDS, gridUnit, isGridId, quantizeNote, quantizeNotes, snap, type GridId } from '../notes/grid';
import { MIN_NOTE_LENGTH } from '../notes/Note';
import { NotePattern } from '../notes/NotePattern';

describe('grid units', () => {
    it('knows every resolution in steps', () => {
        const units = Object.fromEntries(GRIDS.map((grid) => [grid.id, grid.unit]));
        expect(units).toEqual({ off: null, '1/4': 4, '1/8': 2, '1/16': 1, '1/32': 0.5, '1/64': 0.25, '1/8T': 4 / 3, '1/16T': 2 / 3, '1/32T': 1 / 3 });
    });

    it('recognises grid ids', () => {
        expect(isGridId('1/16T')).toBe(true);
        expect(isGridId('1/12')).toBe(false);
        expect(isGridId(null)).toBe(false);
    });
});

describe('snap', () => {
    const cases: [GridId, number, number, number, number][] = [
        // grid, value, round, floor, ceil
        ['1/4', 5.9, 4, 4, 8],
        ['1/8', 2.9, 2, 2, 4],
        ['1/16', 3.6, 4, 3, 4],
        ['1/32', 1.3, 1.5, 1, 1.5],
        ['1/64', 1.13, 1.25, 1, 1.25],
        ['1/8T', 1.9, 4 / 3, 4 / 3, 8 / 3],
        ['1/16T', 1.1, 4 / 3, 2 / 3, 4 / 3],
        ['1/32T', 0.5, 2 / 3, 1 / 3, 2 / 3],
    ];

    it.each(cases)('snaps on %s', (grid, value, round, floor, ceil) => {
        expect(snap(value, grid)).toBeCloseTo(round, 9);
        expect(snap(value, grid, 'floor')).toBeCloseTo(floor, 9);
        expect(snap(value, grid, 'ceil')).toBeCloseTo(ceil, 9);
    });

    it('leaves values alone with the grid off', () => {
        expect(snap(3.1234, 'off')).toBe(3.1234);
        expect(snap(3.1234, 'off', 'floor')).toBe(3.1234);
    });

    it('lands triplet lines that meet a beat exactly on the whole step', () => {
        // Three 1/16 triplets make two steps; the snapped value is 2, not 1.9999999999999998.
        expect(snap(2.01, '1/16T')).toBe(2);
        expect(snap(4, '1/8T', 'floor')).toBe(4);
        expect(snap(4, '1/8T', 'ceil')).toBe(4);
    });

    it('keeps a position that is a hair off a line on that line for floor and ceil', () => {
        expect(snap(2 - 1e-9, '1/16', 'floor')).toBe(2);
        expect(snap(2 + 1e-9, '1/16', 'ceil')).toBe(2);
    });
});

describe('quantize', () => {
    it('moves starts fully onto the grid at 100 %', () => {
        expect(quantizeNote({ start: 3.3, length: 0.8 }, { grid: '1/16', strength: 1, ends: false })).toEqual({ start: 3, length: 0.8 });
        expect(quantizeNote({ start: 1.2, length: 1 }, { grid: '1/16T', strength: 1, ends: false }).start).toBeCloseTo(4 / 3, 9);
    });

    it('moves starts part of the way at lower strengths', () => {
        expect(quantizeNote({ start: 3.4, length: 1 }, { grid: '1/16', strength: 0.5, ends: false }).start).toBeCloseTo(3.2, 9);
        expect(quantizeNote({ start: 3.4, length: 1 }, { grid: '1/16', strength: 0, ends: false })).toEqual({ start: 3.4, length: 1 });
    });

    it('quantizes ends when asked', () => {
        // 3.3 .. 4.1 becomes 3 .. 4.
        const full = quantizeNote({ start: 3.3, length: 0.8 }, { grid: '1/16', strength: 1, ends: true });
        expect(full.start).toBe(3);
        expect(full.length).toBeCloseTo(1, 9);
        // Half way: start 3.15, end 4.05.
        const half = quantizeNote({ start: 3.3, length: 0.8 }, { grid: '1/16', strength: 0.5, ends: true });
        expect(half.start).toBeCloseTo(3.15, 9);
        expect(half.length).toBeCloseTo(0.9, 9);
    });

    it('keeps at least one grid unit when an end would snap onto its start', () => {
        const note = quantizeNote({ start: 2.1, length: 0.2 }, { grid: '1/16', strength: 1, ends: true });
        expect(note).toEqual({ start: 2, length: 1 });
    });

    it('never makes a note shorter than the shortest note', () => {
        const note = quantizeNote({ start: 0, length: MIN_NOTE_LENGTH }, { grid: '1/64', strength: 0.0001, ends: true });
        expect(note.length).toBeGreaterThanOrEqual(MIN_NOTE_LENGTH);
    });

    it('does nothing with the grid off', () => {
        expect(quantizeNote({ start: 1.37, length: 0.5 }, { grid: 'off', strength: 1, ends: true })).toEqual({ start: 1.37, length: 0.5 });
    });

    it('returns only the notes that move, and a pattern applies them in one revision', () => {
        const pattern = new NotePattern(16);
        const on = pattern.addNote({ note: 'C5', start: 4, length: 1 });
        const off = pattern.addNote({ note: 'E5', start: 6.3, length: 1 });
        const late = pattern.addNote({ note: 'G5', start: 15.8, length: 1 });
        const changes = quantizeNotes(pattern.notes, { grid: '1/16', strength: 1, ends: false });
        expect(changes.map((change) => change.id).sort()).toEqual([off.id, late.id].sort());

        const revision = pattern.revision;
        pattern.updateNotes(changes);
        expect(pattern.revision).toBe(revision + 1);
        expect(pattern.getNote(on.id)!.start).toBe(4);
        expect(pattern.getNote(off.id)!.start).toBe(6);
        // 16 is the pattern's end: the note wraps to the top, and the list is sorted again.
        expect(pattern.getNote(late.id)!.start).toBe(0);
        expect(pattern.notes.map((note) => note.start)).toEqual([0, 4, 6]);
    });
});

describe('batch edits', () => {
    it('adds several notes in one revision, sorted', () => {
        const pattern = new NotePattern(16);
        pattern.addNote({ note: 'C5', start: 5, length: 1 });
        const revision = pattern.revision;
        const added = pattern.addNotes([
            { note: 'D5', start: 9, length: 1 },
            { note: 'E5', start: 17, length: 1 },
        ]);
        expect(pattern.revision).toBe(revision + 1);
        expect(added.map((note) => note.start)).toEqual([9, 1]);
        expect(pattern.notes.map((note) => note.note)).toEqual(['E5', 'C5', 'D5']);
    });

    it('updates several notes, keeps chords in order and skips unknown ids', () => {
        const pattern = new NotePattern(16);
        const a = pattern.addNote({ note: 'C5', start: 0, length: 1 });
        const b = pattern.addNote({ note: 'E5', start: 0, length: 1 });
        const c = pattern.addNote({ note: 'G5', start: 4, length: 1 });
        pattern.updateNotes([
            { id: c.id, start: 0, velocity: 2 },
            { id: 'missing', start: 3 },
            { id: a.id, note: 'D5', length: 0 },
        ]);
        expect(pattern.notes.map((note) => note.id)).toEqual([a.id, b.id, c.id]);
        expect(pattern.getNote(c.id)!.velocity).toBe(1);
        expect(pattern.getNote(a.id)).toMatchObject({ note: 'D5', length: MIN_NOTE_LENGTH });
        expect(gridUnit('1/4')).toBe(4);
    });
});
