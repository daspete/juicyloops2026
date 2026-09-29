import { stepOfStart, type PatternNote } from './Note';
import type { NotePattern } from './NotePattern';

/**
 * The step grid as a view onto a pattern's notes. A cell is lit when any note starts in `[step, step + 1)`.
 * Pure helpers: the grid components, the velocity lane and the tests use them.
 */

/** The notes starting in `[step, step + 1)`, in start order. */
export const notesStartingIn = (notes: readonly PatternNote[], step: number): PatternNote[] => notes.filter((note) => stepOfStart(note.start) === step);

/** Per step of a pattern of `length` steps, the notes starting in it. For views; the step callback uses `NotePattern.notesStartingAt`. */
export const stepCells = (notes: readonly PatternNote[], length: number): PatternNote[][] => {
    const cells = Array.from({ length }, (): PatternNote[] => []);
    for (const note of notes) {
        cells[Math.min(length - 1, stepOfStart(note.start))]?.push(note);
    }
    return cells;
};

/** Whether a step's cell is lit. */
export const isStepLit = (notes: readonly PatternNote[], step: number): boolean => notes.some((note) => stepOfStart(note.start) === step);

/**
 * Lights or clears a cell. Clearing removes the notes that start in it; lighting an empty cell adds a note at the
 * pattern's `stepNote`, `stepLength` and `stepVelocity`. A cell already in the state asked for is left alone.
 */
export const setStep = (pattern: NotePattern, step: number, on: boolean): void => {
    const notes = notesStartingIn(pattern.notes, step);
    if (on && !notes.length) {
        pattern.addNote({ note: pattern.stepNote, start: step, length: pattern.stepLength, velocity: pattern.stepVelocity });
    } else if (!on && notes.length) {
        pattern.removeNotes(notes.map((note) => note.id));
    }
};

/** Flips a cell (see `setStep`). */
export const toggleStep = (pattern: NotePattern, step: number): void => setStep(pattern, step, !isStepLit(pattern.notes, step));

/** The velocity a step's bar shows: the loudest note starting in it, 0 for an empty step. */
export const stepVelocity = (notes: readonly PatternNote[]): number => notes.reduce((loudest, note) => Math.max(loudest, note.velocity), 0);

/** Sets the velocity of every note starting in a step. An empty step has nothing to set. */
export const setStepVelocity = (pattern: NotePattern, step: number, velocity: number): void => {
    for (const note of notesStartingIn(pattern.notes, step)) {
        pattern.updateNote(note.id, { velocity });
    }
};

/** The last cell a note covers in the grid: from its start cell for its length, at least its own cell, never past the pattern's end. */
export const lastCellOf = (note: PatternNote, patternLength: number): number => {
    const head = stepOfStart(note.start);
    return Math.min(patternLength - 1, Math.max(head, Math.ceil(note.start + note.length - 1e-6) - 1));
};
