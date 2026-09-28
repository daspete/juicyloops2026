import { MIN_NOTE_LENGTH } from './Note';

/**
 * Grid resolutions for the piano roll: where edits snap to and what Quantize pulls notes onto.
 *
 * Positions are in steps (one step is a 16th). A resolution is named like a note value: `1/8` is two steps, `1/64`
 * a quarter step. Triplet resolutions fit three notes where two would go: `1/8T` is 4/3 of a step (three per quarter),
 * `1/16T` 2/3 and `1/32T` 1/3. `off` is no grid at all. Pure helpers, no Vue.
 */
export type GridId = 'off' | '1/4' | '1/8' | '1/16' | '1/32' | '1/64' | '1/8T' | '1/16T' | '1/32T';

export interface GridOption {
    id: GridId;
    label: string;
    /** The grid unit in steps; null for `off`. */
    unit: number | null;
}

export const GRIDS: readonly GridOption[] = [
    { id: 'off', label: 'Off', unit: null },
    { id: '1/4', label: '1/4', unit: 4 },
    { id: '1/8', label: '1/8', unit: 2 },
    { id: '1/16', label: '1/16', unit: 1 },
    { id: '1/32', label: '1/32', unit: 1 / 2 },
    { id: '1/64', label: '1/64', unit: 1 / 4 },
    { id: '1/8T', label: '1/8 T', unit: 4 / 3 },
    { id: '1/16T', label: '1/16 T', unit: 2 / 3 },
    { id: '1/32T', label: '1/32 T', unit: 1 / 3 },
];

export const DEFAULT_GRID: GridId = '1/16';

export const isGridId = (value: unknown): value is GridId => GRIDS.some((grid) => grid.id === value);

/** The grid unit in steps, or null when snapping is off. */
export const gridUnit = (grid: GridId): number | null => GRIDS.find((option) => option.id === grid)?.unit ?? null;

/** Cleans float dust (`2/3 * 3 = 2.0000000000000004`) so snapped positions compare and bucket as the whole numbers they are. */
const clean = (value: number): number => Math.round(value * 1e9) / 1e9;

export type SnapMode = 'round' | 'floor' | 'ceil';

/**
 * Puts a position (steps) onto the grid: the nearest line (`round`), the line at or before it (`floor`, where a click
 * places a note) or at or after it (`ceil`). With the grid off the value comes back unchanged.
 */
export const snap = (value: number, grid: GridId, mode: SnapMode = 'round'): number => {
    const unit = gridUnit(grid);
    if (unit === null) {
        return value;
    }
    const units = value / unit;
    // A position a hair off a line (arithmetic) counts as on it, so `floor` and `ceil` do not jump a whole unit.
    const near = Math.round(units);
    const whole = Math.abs(units - near) < 1e-6 ? near : mode === 'floor' ? Math.floor(units) : mode === 'ceil' ? Math.ceil(units) : near;
    return clean(whole * unit);
};

export interface QuantizeOptions {
    grid: GridId;
    /** How far a note moves toward its grid line, 0..1 (1 lands on it). */
    strength: number;
    /** Quantize where notes end as well; otherwise lengths stay as they are. */
    ends: boolean;
}

/** Where a note lands after quantizing; its length only changes when ends are quantized too. */
export const quantizeNote = (note: { start: number; length: number }, options: QuantizeOptions): { start: number; length: number } => {
    const unit = gridUnit(options.grid);
    const strength = Math.min(1, Math.max(0, options.strength));
    if (unit === null || strength === 0) {
        return { start: note.start, length: note.length };
    }
    const toward = (value: number, target: number) => clean(value + (target - value) * strength);
    const startTarget = snap(note.start, options.grid);
    const start = toward(note.start, startTarget);
    if (!options.ends) {
        return { start, length: note.length };
    }
    const end = note.start + note.length;
    // An end never snaps onto (or before) its own start: a short note keeps at least one grid unit.
    const endTarget = Math.max(snap(end, options.grid), startTarget + unit);
    const length = Math.max(MIN_NOTE_LENGTH, clean(toward(end, endTarget) - start));
    return { start, length };
};

/** Quantizes several notes; only the notes that actually move are returned, ready for `NotePattern.updateNotes`. */
export const quantizeNotes = <T extends { id: string; start: number; length: number }>(
    notes: readonly T[],
    options: QuantizeOptions,
): { id: string; start: number; length: number }[] =>
    notes.flatMap((note) => {
        const next = quantizeNote(note, options);
        return next.start === note.start && next.length === note.length ? [] : [{ id: note.id, ...next }];
    });
