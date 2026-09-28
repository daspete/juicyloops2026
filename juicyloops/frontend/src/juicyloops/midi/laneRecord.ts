import type { AutomationPoint } from '../automation';

/**
 * Recording controllers (learned CCs, pitch bend) into a track's step automation lanes. Pure helpers over plain point
 * arrays; the recorder hands them the reactive lanes, so the curve grows in the view while recording runs.
 *
 * A controller sends dozens of messages a second. They are thinned (`ControllerThinner`) before they become points,
 * and a gesture writes over the lane's old curve where it passes (`writeRecordedPoint`), like the "touch" mode of a
 * DAW, instead of zig-zagging through the old points.
 */

/** A value is only kept when it moved by more than this (0..1 of the parameter's range)... */
export const CC_MIN_CHANGE = 0.005;
/** ...and at least this many steps after the last kept one... */
export const CC_MIN_SPACING = 1 / 64;
/** ...and never more than this many in one step. */
export const CC_MAX_PER_STEP = 16;

/**
 * Thins one controller stream, in running steps (the transport's count, not pattern positions: a gesture across the
 * loop end stays one stream). A value that moved but came too soon is remembered; `flush` hands it back once the
 * stream ends, so the lane ends on the value the controller was left at.
 */
export class ControllerThinner<T = unknown> {
    private lastStep = Number.NEGATIVE_INFINITY;
    private lastValue = Number.NaN;
    private bucket = Number.NaN;
    private count = 0;
    private pending: T | null = null;

    /** Whether a value at running step `step` is kept. `payload` is what `flush` returns for a dropped one. */
    offer(step: number, value: number, payload: T): boolean {
        const bucket = Math.floor(step);
        if (bucket !== this.bucket) {
            this.bucket = bucket;
            this.count = 0;
        }
        const moved = !(Math.abs(value - this.lastValue) <= CC_MIN_CHANGE);
        if (!moved) {
            // Back where the last kept point is: nothing to add, and nothing left to say at the end.
            this.pending = null;
            return false;
        }
        if (step - this.lastStep < CC_MIN_SPACING - 1e-9 || this.count >= CC_MAX_PER_STEP) {
            this.pending = payload;
            return false;
        }
        this.lastStep = step;
        this.lastValue = value;
        this.count++;
        this.pending = null;
        return true;
    }

    /** The last value that moved but was dropped (the controller's final position), once; null when there is none. */
    flush(): T | null {
        const pending = this.pending;
        this.pending = null;
        return pending;
    }
}

/**
 * Whether `step` lies in the stretch `(from, to]` of a looping lane; when `to < from` the stretch wraps across the
 * lane's end.
 */
export const inStretch = (step: number, from: number, to: number): boolean => (from <= to ? step > from && step <= to : step > from || step <= to);

/** Removes the points that `drop` says go, in one splice. */
const removeWhere = (points: AutomationPoint[], drop: (point: AutomationPoint) => boolean): void => {
    const kept = points.filter((point) => !drop(point));
    if (kept.length !== points.length) {
        points.splice(0, points.length, ...kept);
    }
};

/**
 * Puts a recorded point into a lane's sorted points; a point already on the same step is replaced. With `from` (where
 * the same gesture wrote its previous point), the lane's older points between the two go (points `isOwn` claims,
 * those this take recorded, stay), so the gesture replaces the curve it passes over. Returns the point as stored.
 */
export const writeRecordedPoint = (points: AutomationPoint[], point: AutomationPoint, from: number | null, isOwn: (point: AutomationPoint) => boolean): AutomationPoint => {
    if (from !== null) {
        removeWhere(points, (existing) => !isOwn(existing) && inStretch(existing.step, from, point.step));
    }
    let low = 0;
    let high = points.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (points[mid]!.step < point.step) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    const same = points[low];
    if (same && same.step === point.step) {
        points.splice(low, 1, point);
    } else {
        points.splice(low, 0, point);
    }
    return point;
};

/** Replace mode: removes the points in pattern step `[step, step + 1)` of a lane, except the take's own. */
export const clearLaneStep = (points: AutomationPoint[], step: number, isOwn: (point: AutomationPoint) => boolean): void => {
    removeWhere(points, (point) => !isOwn(point) && point.step >= step && point.step < step + 1);
};
