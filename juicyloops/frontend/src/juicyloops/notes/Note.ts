/**
 * A note of a track's pattern.
 *
 * `start` and `length` are in steps (one step is a 16th) and can be fractional. A note starts inside the pattern
 * (`0 <= start < pattern length`); its length may run past the pattern's end, and the tail then rings across the
 * wrap. `velocity` is 0..1. Several notes may start at the same time (chords).
 *
 * On a synth track the note is the pitch; on a sample track it picks the pitch of a whole sample or the slice of a
 * cut one (see `SampleTrack.sliceIndexOf`).
 */
export interface PatternNote {
    id: string;
    note: string;
    start: number;
    length: number;
    velocity: number;
}

/** What a note is made from; a missing id gets a new one, a missing velocity is full. */
export interface NoteInput {
    id?: string;
    note: string;
    start: number;
    length: number;
    velocity?: number;
}

/** The shortest note there is, in steps (a 1/1024 note). Shorter lengths are raised to it. */
export const MIN_NOTE_LENGTH = 1 / 64;

/**
 * How far below a whole step a start may sit and still count as that step. Starts that are whole numbers on paper
 * can come out a hair below after arithmetic (a rotation, a quantize); they belong to the step they mean.
 */
const STEP_EPSILON = 1e-6;

/** The step a note starting at `start` belongs to: the cell it lights in the grid, the step callback that schedules it. */
export const stepOfStart = (start: number): number => Math.floor(start + STEP_EPSILON);

/** Orders notes by their start. */
export const byStart = (a: PatternNote, b: PatternNote): number => a.start - b.start;

export const copyNote = (note: PatternNote): PatternNote => ({ id: note.id, note: note.note, start: note.start, length: note.length, velocity: note.velocity });

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Wraps a start into a pattern of `length` steps. */
export const wrapStart = (start: number, length: number): number => {
    if (start >= 0 && start < length) {
        // Already inside: returned as is, since the modulo below adds float dust (4.6 comes back as 4.600000000000001).
        return start;
    }
    const wrapped = ((start % length) + length) % length;
    // `-1e-17 % 32` is -1e-17, and adding 32 gives 32 itself.
    return wrapped >= length ? 0 : wrapped;
};

/** Brings the values of a note into range: the start into the pattern, a positive length, velocity 0..1. */
export const normalizeNoteValues = <T extends { start: number; length: number; velocity: number }>(note: T, patternLength: number): T => {
    note.start = Number.isFinite(note.start) ? wrapStart(note.start, patternLength) : 0;
    note.length = Number.isFinite(note.length) ? Math.max(MIN_NOTE_LENGTH, note.length) : 1;
    note.velocity = Number.isFinite(note.velocity) ? clamp01(note.velocity) : 1;
    return note;
};
