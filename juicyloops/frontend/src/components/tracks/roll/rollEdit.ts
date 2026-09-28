import { DEFAULT_GRID, gridUnit, isGridId, type GridId } from '@/juicyloops/notes/grid';
import { MIN_NOTE_LENGTH, type PatternNote } from '@/juicyloops/notes/Note';

/**
 * Helpers of the piano roll that need no component: how far a group of notes may move, the clipboard, and the snap
 * setting every roll keeps in localStorage.
 */

/** A note as a group edit sees it: where it was when the gesture began, and on which row. */
export interface NoteOrigin {
    id: string;
    note: string;
    start: number;
    length: number;
    velocity: number;
    row: number;
}

/** Tolerance for positions that should count as equal. */
const EPSILON = 1e-6;

/**
 * Limits a group move so every note keeps its start inside the pattern (`0 <= start < length`). A move that would push
 * a note out is shortened by whole `unit`s (so snapped notes stay on the grid), or, without a unit, cut to fit.
 */
export const clampShift = (origins: readonly NoteOrigin[], shift: number, patternLength: number, unit: number | null): number => {
    if (!origins.length) {
        return 0;
    }
    let first = Infinity;
    let last = -Infinity;
    for (const origin of origins) {
        first = Math.min(first, origin.start);
        last = Math.max(last, origin.start);
    }
    const low = -first;
    const high = patternLength - last - (unit ?? MIN_NOTE_LENGTH);
    if (shift >= low - EPSILON && shift <= high + EPSILON) {
        return shift;
    }
    if (unit === null) {
        return Math.min(high, Math.max(low, shift));
    }
    // Step back toward no move, a unit at a time, until the group fits.
    const direction = shift > 0 ? -1 : 1;
    let fitted = shift;
    while ((fitted < low - EPSILON || fitted > high + EPSILON) && Math.sign(fitted) !== direction) {
        fitted += direction * unit;
    }
    return Math.sign(fitted) === direction ? 0 : fitted;
};

/** Limits a move across rows so every note stays on a row of the roll. */
export const clampRowShift = (origins: readonly NoteOrigin[], shift: number, rowCount: number): number => {
    if (!origins.length) {
        return 0;
    }
    let top = Infinity;
    let bottom = -Infinity;
    for (const origin of origins) {
        top = Math.min(top, origin.row);
        bottom = Math.max(bottom, origin.row);
    }
    return Math.min(rowCount - 1 - bottom, Math.max(-top, shift));
};

/** Where a group of notes starts and ends (the latest end of any of them). */
export const spanOf = (notes: readonly Pick<PatternNote, 'start' | 'length'>[]): { start: number; end: number } => {
    let start = Infinity;
    let end = -Infinity;
    for (const note of notes) {
        start = Math.min(start, note.start);
        end = Math.max(end, note.start + note.length);
    }
    return notes.length ? { start, end } : { start: 0, end: 0 };
};

/* ---- clipboard ---- */

/** Copied notes, their starts relative to the first one. Shared by every roll, so notes can move between tracks. */
export interface RollClipboard {
    notes: { note: string; start: number; length: number; velocity: number }[];
    /** Where the copied notes ended in their pattern: a paste with nothing else to go by lands there. */
    end: number;
}

let clipboard: RollClipboard | null = null;

export const copyToClipboard = (notes: readonly PatternNote[]): void => {
    if (!notes.length) {
        return;
    }
    const span = spanOf(notes);
    clipboard = {
        notes: notes.map((note) => ({ note: note.note, start: note.start - span.start, length: note.length, velocity: note.velocity })),
        end: span.end,
    };
};

export const readClipboard = (): RollClipboard | null => clipboard;

/* ---- the snap setting ---- */

const SNAP_KEY = 'jl.pianoroll.snap';
/** Rolls remembered; the oldest are forgotten beyond this. */
const SNAP_LIMIT = 200;

const readSnaps = (): Record<string, GridId> => {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(SNAP_KEY) ?? '{}');
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, GridId>) : {};
    } catch {
        return {};
    }
};

/** The snap a roll was left at (per roll, i.e. per track), or the default. */
export const loadSnap = (rollId: string): GridId => {
    const stored = readSnaps()[rollId];
    return isGridId(stored) ? stored : DEFAULT_GRID;
};

export const saveSnap = (rollId: string, grid: GridId): void => {
    try {
        const snaps = readSnaps();
        delete snaps[rollId];
        snaps[rollId] = grid;
        const ids = Object.keys(snaps);
        for (const id of ids.slice(0, Math.max(0, ids.length - SNAP_LIMIT))) {
            delete snaps[id];
        }
        localStorage.setItem(SNAP_KEY, JSON.stringify(snaps));
    } catch {
        // Storage unavailable (private mode): the roll just forgets.
    }
};

/** The step a nudge or a click-length uses: the grid unit, or one step with the grid off. */
export const editUnit = (grid: GridId): number => gridUnit(grid) ?? 1;
