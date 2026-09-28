import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { MIN_NOTE_LENGTH, stepOfStart, type PatternNote } from '../notes/Note';
import { NotePattern } from '../notes/NotePattern';
import { isStepLit, lastCellOf, notesStartingIn, setStep, setStepVelocity, stepCells, stepVelocity, toggleStep } from '../notes/stepView';
import { ALL_NOTES_DESCENDING, MAX_OCTAVE, MIN_OCTAVE, NOTE_NAMES, noteAt, noteIndex, OCTAVES, parseNote, semitonesBetween, shiftOctave, transpose } from '../notes';

describe('notes', () => {
    it('lists every note of every octave from high to low', () => {
        expect(ALL_NOTES_DESCENDING).toHaveLength(NOTE_NAMES.length * OCTAVES.length);
        expect(ALL_NOTES_DESCENDING[0]).toBe(`B${MAX_OCTAVE}`);
        expect(ALL_NOTES_DESCENDING[ALL_NOTES_DESCENDING.length - 1]).toBe(`C${MIN_OCTAVE}`);
    });

    it('parses notes with and without accidentals', () => {
        expect(parseNote('C4')).toEqual({ name: 'C', octave: 4 });
        expect(parseNote('F#10')).toEqual({ name: 'F#', octave: 10 });
        expect(parseNote('nope')).toBeNull();
    });

    it('shifts octaves and clamps to the supported range', () => {
        expect(shiftOctave('C4', 1)).toBe('C5');
        expect(shiftOctave('D#2', -1)).toBe('D#1');
        expect(shiftOctave(`A${MAX_OCTAVE}`, 1)).toBe(`A${MAX_OCTAVE}`);
        expect(shiftOctave(`A${MIN_OCTAVE}`, -1)).toBe(`A${MIN_OCTAVE}`);
    });

    it('leaves unknown notes untouched', () => {
        expect(shiftOctave('garbage', 1)).toBe('garbage');
    });

    it('counts and moves by semitones, clamped to the supported range', () => {
        expect(noteIndex('C0')).toBe(0);
        expect(noteIndex('C5')).toBe(60);
        expect(noteIndex('nope')).toBeNull();
        expect(noteAt(61)).toBe('C#5');
        expect(semitonesBetween('C5', 'A4')).toBe(-3);
        expect(transpose('B4', 1)).toBe('C5');
        expect(transpose('C0', -5)).toBe('C0');
        expect(transpose('nope', 2)).toBe('nope');
    });
});

const starts = (pattern: NotePattern) => pattern.notes.map((note) => note.start);
const pitches = (pattern: NotePattern) => pattern.notes.map((note) => note.note);

describe('note pattern', () => {
    it('keeps notes sorted by start and bumps the revision on every edit', () => {
        const pattern = new NotePattern(16);
        const r0 = pattern.revision;
        pattern.addNote({ note: 'C5', start: 4, length: 1 });
        pattern.addNote({ note: 'D5', start: 1.5, length: 2, velocity: 0.5 });
        const last = pattern.addNote({ note: 'E5', start: 4, length: 1 });
        expect(starts(pattern)).toEqual([1.5, 4, 4]);
        // Equal starts keep the order they came in.
        expect(pattern.notes[2]).toBe(last);
        expect(pattern.revision).toBe(r0 + 3);

        pattern.updateNote(last.id, { start: 0 });
        expect(starts(pattern)).toEqual([0, 1.5, 4]);
        pattern.removeNotes([last.id]);
        expect(pitches(pattern)).toEqual(['D5', 'C5']);
        expect(pattern.revision).toBe(r0 + 5);
    });

    it('brings values into range: starts wrap into the pattern, lengths stay positive, velocity 0..1', () => {
        const pattern = new NotePattern(16);
        const a = pattern.addNote({ note: 'C5', start: 17.5, length: 0, velocity: 3 });
        const b = pattern.addNote({ note: 'C5', start: -1, length: 40, velocity: -1 });
        expect(a).toMatchObject({ start: 1.5, length: MIN_NOTE_LENGTH, velocity: 1 });
        // The length may run past the pattern's end: the tail rings across the wrap.
        expect(b).toMatchObject({ start: 15, length: 40, velocity: 0 });
        expect(a.id).not.toBe(b.id);
    });

    it('remembers the last pitch placed for new steps', () => {
        const pattern = new NotePattern(16);
        expect(pattern.stepNote).toBe('C5');
        const note = pattern.addNote({ note: 'G3', start: 0, length: 1 });
        expect(pattern.stepNote).toBe('G3');
        pattern.updateNote(note.id, { note: 'A2' });
        expect(pattern.stepNote).toBe('A2');
    });

    it('replaces notes, keeping the objects of notes that are still there', () => {
        const pattern = new NotePattern(16);
        const kept = pattern.addNote({ id: 'a', note: 'C5', start: 2, length: 1 });
        pattern.addNote({ id: 'b', note: 'C5', start: 3, length: 1 });
        pattern.setNotes([
            { id: 'c', note: 'E5', start: 5, length: 1 },
            { id: 'a', note: 'D5', start: 1, length: 2, velocity: 0.5 },
        ]);
        expect(pattern.notes.map((note) => note.id)).toEqual(['a', 'c']);
        expect(pattern.notes[0]).toBe(kept);
        expect(kept).toEqual({ id: 'a', note: 'D5', start: 1, length: 2, velocity: 0.5 });
    });

    it('serializes copies', () => {
        const pattern = new NotePattern(16);
        pattern.addNote({ id: 'a', note: 'C5', start: 2, length: 1 });
        const saved = pattern.serializeNotes();
        expect(saved).toEqual([{ id: 'a', note: 'C5', start: 2, length: 1, velocity: 1 }]);
        expect(saved[0]).not.toBe(pattern.notes[0]);
    });
});

describe('bucket index', () => {
    it('lists the notes starting in each step, fractional starts and chords included', () => {
        const pattern = new NotePattern(8);
        pattern.setNotes([
            { id: 'a', note: 'C5', start: 0, length: 1 },
            { id: 'b', note: 'E5', start: 0, length: 1 },
            { id: 'c', note: 'G5', start: 2.75, length: 0.25 },
            { id: 'd', note: 'C6', start: 7.99, length: 4 },
        ]);
        const ids = (position: number) => pattern.notesStartingAt(position).map((note) => note.id);
        expect(ids(0)).toEqual(['a', 'b']);
        expect(ids(1)).toEqual([]);
        expect(ids(2)).toEqual(['c']);
        expect(ids(7)).toEqual(['d']);
        expect(ids(8)).toEqual([]);
    });

    it('is rebuilt only when the notes or the length change', () => {
        const pattern = new NotePattern(8);
        pattern.addNote({ id: 'a', note: 'C5', start: 3, length: 1 });
        const first = pattern.notesStartingAt(3);
        // No edit, no rebuild: the same array comes back.
        expect(pattern.notesStartingAt(3)).toBe(first);
        expect(pattern.notesStartingAt(3)).toHaveLength(1);

        pattern.updateNote('a', { start: 5 });
        expect(pattern.notesStartingAt(3)).toHaveLength(0);
        expect(pattern.notesStartingAt(5).map((note) => note.id)).toEqual(['a']);

        pattern.setLength(4);
        expect(pattern.notesStartingAt(5)).toHaveLength(0);
    });

    it('holds raw notes even when the pattern is edited and read through a reactive proxy', () => {
        const pattern = reactive(new NotePattern(8)) as NotePattern;
        pattern.addNote({ id: 'a', note: 'C5', start: 1, length: 1 });
        const note = pattern.notesStartingAt(1)[0]!;
        // A raw note is not a proxy: the step callback reads it without Vue's traps.
        expect(note).not.toBe(pattern.notes[0]);
        expect(note).toEqual(pattern.notes[0]);
    });
});

describe('step view', () => {
    const noteAtStep = (pattern: NotePattern, step: number): PatternNote | undefined => notesStartingIn(pattern.notes, step)[0];

    it('lights a cell when a note starts anywhere inside the step', () => {
        const notes: PatternNote[] = [
            { id: 'a', note: 'C5', start: 1.5, length: 1, velocity: 1 },
            { id: 'b', note: 'C5', start: 3, length: 1, velocity: 0.3 },
            { id: 'c', note: 'E5', start: 3, length: 1, velocity: 0.7 },
        ];
        expect([0, 1, 2, 3].map((step) => isStepLit(notes, step))).toEqual([false, true, false, true]);
        expect(stepCells(notes, 4).map((cell) => cell.length)).toEqual([0, 1, 0, 2]);
        expect(stepVelocity(notesStartingIn(notes, 3))).toBe(0.7);
        expect(stepVelocity([])).toBe(0);
        expect(stepOfStart(2.9999999999)).toBe(3);
    });

    it('toggles steps: an empty cell gets a one-step note at the step pitch, a lit one loses its notes', () => {
        const pattern = new NotePattern(16);
        pattern.stepNote = 'A3';
        toggleStep(pattern, 4);
        expect(noteAtStep(pattern, 4)).toMatchObject({ note: 'A3', start: 4, length: 1, velocity: 1 });

        pattern.addNote({ note: 'C5', start: 4.5, length: 1 });
        toggleStep(pattern, 4);
        expect(pattern.notes).toEqual([]);

        // Painting: a cell already in the asked state is left alone.
        setStep(pattern, 2, true);
        setStep(pattern, 2, true);
        expect(pattern.notes).toHaveLength(1);
        setStep(pattern, 3, false);
        expect(pattern.notes).toHaveLength(1);
    });

    it('sets the velocity of the notes starting in a step', () => {
        const pattern = new NotePattern(16);
        pattern.setNotes([
            { note: 'C5', start: 2, length: 1 },
            { note: 'E5', start: 2.5, length: 1 },
            { note: 'G5', start: 3, length: 1 },
        ]);
        setStepVelocity(pattern, 2, 0.25);
        expect(pattern.notes.map((note) => note.velocity)).toEqual([0.25, 0.25, 1]);
    });

    it('knows the last cell a note covers', () => {
        const note = (start: number, length: number): PatternNote => ({ id: 'x', note: 'C5', start, length, velocity: 1 });
        expect(lastCellOf(note(3, 0.25), 16)).toBe(3);
        expect(lastCellOf(note(3, 1), 16)).toBe(3);
        expect(lastCellOf(note(3, 2), 16)).toBe(4);
        expect(lastCellOf(note(3.5, 1), 16)).toBe(4);
        expect(lastCellOf(note(14, 8), 16)).toBe(15);
    });
});

describe('pattern tools', () => {
    afterEach(() => vi.restoreAllMocks());

    it('fills every n-th step with one-step notes and keeps notes already on those steps', () => {
        const pattern = new NotePattern(16);
        const kept = pattern.addNote({ note: 'G3', start: 4.25, length: 3, velocity: 0.5 });
        pattern.addNote({ note: 'A3', start: 6, length: 1 });
        pattern.stepNote = 'C5';
        pattern.activateEveryNth(4);
        expect(starts(pattern)).toEqual([0, 4.25, 8, 12]);
        expect(pattern.notes[1]).toBe(kept);
        expect(pattern.notes.filter((note) => note !== kept).every((note) => note.length === 1 && note.velocity === 1 && note.note === 'C5')).toBe(true);
    });

    it('randomizes which steps hold a note', () => {
        const rolls = [0.1, 0.9, 0.3, 0.5];
        vi.spyOn(Math, 'random').mockImplementation(() => rolls.shift() ?? 0.9);
        const pattern = new NotePattern(4);
        pattern.randomize(0.4);
        expect(starts(pattern)).toEqual([0, 2]);
    });

    it('rotates every note by a step and wraps its start', () => {
        const pattern = new NotePattern(8);
        pattern.setNotes([
            { note: 'C5', start: 0, length: 1 },
            { note: 'D5', start: 3.5, length: 2 },
            { note: 'E5', start: 7.25, length: 1 },
        ]);
        pattern.rotate(1);
        expect(starts(pattern)).toEqual([0.25, 1, 4.5]);
        expect(pitches(pattern)).toEqual(['E5', 'C5', 'D5']);
        pattern.rotate(-1);
        pattern.rotate(-1);
        expect(starts(pattern)).toEqual([2.5, 6.25, 7]);
    });

    it('clears, shifts octaves and sets every length', () => {
        const pattern = new NotePattern(8);
        pattern.setNotes([
            { note: 'C5', start: 0, length: 1 },
            { note: `A${MAX_OCTAVE}`, start: 2, length: 0.5 },
        ]);
        pattern.shiftOctave(1);
        expect(pitches(pattern)).toEqual(['C6', `A${MAX_OCTAVE}`]);
        pattern.setAllNoteLengths(4);
        expect(pattern.notes.map((note) => note.length)).toEqual([4, 4]);
        // A step switched on later gets the same length.
        toggleStep(pattern, 5);
        expect(notesStartingIn(pattern.notes, 5)[0]?.length).toBe(4);
        pattern.clear();
        expect(pattern.notes).toEqual([]);
    });
});
