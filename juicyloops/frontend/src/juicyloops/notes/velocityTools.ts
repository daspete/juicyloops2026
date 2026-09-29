import { segmentProgress, type CurveShape } from '../automation';
import { stepOfStart } from './Note';

/**
 * The editing tools of the velocity lane, as pure functions: each takes the notes it may touch and returns the
 * velocities to set (`{ id, velocity }`), which the lane hands to `NotePattern.updateNotes` in one batch, so a whole
 * gesture or command is one undo step. Notes whose velocity would not change are left out.
 *
 * The line tools work on a position `at` along the lane (pixels, or steps: anything that grows left to right),
 * the step tools on the note's `start`.
 */

export interface VelocityChange {
    id: string;
    velocity: number;
}

/** A note as the line tools see it: where its stem is along the lane. */
export interface VelocityItem {
    id: string;
    /** Position along the lane, in any unit that grows to the right. */
    at: number;
    velocity: number;
}

/** A note as the step tools see it. */
export interface VelocityNote {
    id: string;
    start: number;
    velocity: number;
}

/** A point the line tools draw from or to: a position along the lane and a velocity. */
export interface VelocityPoint {
    at: number;
    value: number;
}

/** Velocities are kept to whole percent: what the readout shows is what is stored. */
export const clampVelocity = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;

const changed = <T extends { id: string; velocity: number }>(notes: readonly T[], next: (note: T, index: number) => number): VelocityChange[] =>
    notes.flatMap((note, index) => {
        const velocity = clampVelocity(next(note, index));
        return velocity === note.velocity ? [] : [{ id: note.id, velocity }];
    });

/**
 * The value of a ramp from `a` to `b` at `at`, shaped like an automation segment (`curve` or `s-curve` with a
 * tension of -1..1; 0 is a straight line). Outside the ramp the nearer end's value holds. A ramp with no width is the
 * value of its later point.
 */
export const rampValue = (a: VelocityPoint, b: VelocityPoint, at: number, shape: CurveShape = 'curve', tension = 0): number => {
    const [from, to] = a.at <= b.at ? [a, b] : [b, a];
    // Tension belongs to the direction the ramp was drawn in; drawn right to left, the shape is mirrored.
    const k = a.at <= b.at ? tension : shape === 's-curve' ? tension : -tension;
    const span = to.at - from.at;
    if (span <= 0) {
        return b.value;
    }
    return from.value + segmentProgress((at - from.at) / span, shape, k) * (to.value - from.value);
};

/**
 * Line and curve tool: every note from `a` to `b` (widened by `reach` on both sides, so a stem right at an end is
 * caught) takes the ramp's value at its stem. Also what a sweep of the draw tool sets between two pointer events.
 */
export const rampNotes = (
    items: readonly VelocityItem[],
    a: VelocityPoint,
    b: VelocityPoint,
    { shape = 'curve', tension = 0, reach = 0 }: { shape?: CurveShape; tension?: number; reach?: number } = {},
): VelocityChange[] => {
    const low = Math.min(a.at, b.at) - reach;
    const high = Math.max(a.at, b.at) + reach;
    return changed(
        items.filter((item) => item.at >= low && item.at <= high),
        (item) => rampValue(a, b, item.at, shape, tension),
    );
};

/** Every note to one velocity. */
export const setAll = (notes: readonly VelocityNote[], value: number): VelocityChange[] => changed(notes, () => value);

/** Nudges every note by a random amount of up to ±`amount` (0..1), the way a player never hits twice the same. */
export const humanize = (notes: readonly VelocityNote[], amount: number, random: () => number = Math.random): VelocityChange[] =>
    changed(notes, (note) => note.velocity + (random() * 2 - 1) * amount);

/** Every note to a random velocity between `min` and `max`. */
export const randomize = (notes: readonly VelocityNote[], min: number, max: number, random: () => number = Math.random): VelocityChange[] =>
    changed(notes, () => min + random() * (max - min));

/**
 * Spreads the velocities away from their average (`factor` > 1, more dynamic) or pulls them towards it (< 1, flatter).
 * The average stays where it is, apart from notes that hit 0 or 100 %.
 */
export const scaleAroundAverage = (notes: readonly VelocityNote[], factor: number): VelocityChange[] => {
    if (!notes.length) {
        return [];
    }
    const average = notes.reduce((sum, note) => sum + note.velocity, 0) / notes.length;
    return changed(notes, (note) => average + (note.velocity - average) * factor);
};

/**
 * A straight ramp from `from` to `to` across the notes in time: the first note gets `from`, the last `to`, the ones
 * between by where they start. Notes sharing one start (a chord) get the same value.
 */
export const rampOverTime = (notes: readonly VelocityNote[], from: number, to: number): VelocityChange[] => {
    if (!notes.length) {
        return [];
    }
    const first = Math.min(...notes.map((note) => note.start));
    const last = Math.max(...notes.map((note) => note.start));
    return changed(notes, (note) => (last > first ? from + ((note.start - first) / (last - first)) * (to - from) : to));
};

/** Accents: notes starting on every `every`th step (0, every, 2·every, ...) get `accent`, all others `base`. */
export const accentEvery = (notes: readonly VelocityNote[], every: number, accent = 1, base = 0.7): VelocityChange[] => {
    const period = Math.max(1, Math.round(every));
    return changed(notes, (note) => (stepOfStart(note.start) % period === 0 ? accent : base));
};

/**
 * Moves every note by the same amount from where it was when a drag began (`origins`), for grabbing a stem (or a
 * selection of them). Returns every note, changed or not: the caller compares against the current velocities.
 */
export const shiftFrom = (origins: readonly VelocityChange[], delta: number): VelocityChange[] =>
    origins.map((origin) => ({ id: origin.id, velocity: clampVelocity(origin.velocity + delta) }));
