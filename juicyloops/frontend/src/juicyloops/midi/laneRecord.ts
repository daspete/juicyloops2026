import { sameTarget, segmentValue, valueAt, type AutomationPoint, type AutomationTarget, type SongAutomationLane } from '../automation';

/**
 * Recording controllers (learned CCs, pitch bend) into a track's step automation lanes. Pure helpers over plain point
 * arrays; the recorder hands them the reactive lanes, so the curve grows in the view while recording runs.
 *
 * A controller sends dozens of messages a second. They are thinned (`ControllerThinner`) before they become points,
 * and a gesture writes over the lane's old curve where it passes (`writeRecordedPoint`), like the "touch" mode of a
 * DAW, instead of zig-zagging through the old points. Hold points at a gesture's ends (`LaneWriter`) keep the old curve
 * as it was right up to where the gesture starts and from where it ends.
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

    /**
     * Whether the step of the last value offered already holds the most points it may: then a value `flush` hands back
     * takes the place of that step's last kept point instead of adding one.
     */
    get isFull(): boolean {
        return this.count >= CC_MAX_PER_STEP;
    }

    /**
     * Takes one place in the current step without a value: a hold point (see `LaneWriter`) went into it, and the step
     * still holds no more than `CC_MAX_PER_STEP` points.
     */
    reserve(): void {
        this.count++;
    }

    /** The last value that moved but was dropped (the controller's final position), once; null when there is none. */
    flush(): T | null {
        const pending = this.pending;
        this.pending = null;
        return pending;
    }
}

/** Where a lane's positions jump back: a step lane wraps at its pattern's end, a song lane at the loop region's or song's end. */
export interface LaneWrap {
    start: number;
    end: number;
}

/**
 * Whether `step` lies in the stretch `(from, to]` of a looping lane; when `to < from` the stretch wraps across the
 * lane's end: from `from` to the end of `wrap`, then from its start to `to` (without `wrap`, the whole lane is the loop).
 */
export const inStretch = (step: number, from: number, to: number, wrap?: LaneWrap): boolean => {
    if (from <= to) {
        return step > from && step <= to;
    }
    return wrap ? (step > from && step < wrap.end) || (step >= wrap.start && step <= to) : step > from || step <= to;
};

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
 * those this take recorded, stay), so the gesture replaces the curve it passes over; a stretch that went back past
 * `wrap`'s end (see `inStretch`) wraps. The older points that go (also one replaced on the same step) are added to
 * `removed` when given. Returns the point as stored.
 */
export const writeRecordedPoint = (
    points: AutomationPoint[],
    point: AutomationPoint,
    from: number | null,
    isOwn: (point: AutomationPoint) => boolean,
    wrap?: LaneWrap,
    removed?: AutomationPoint[],
): AutomationPoint => {
    if (from !== null) {
        removeWhere(points, (existing) => {
            const drop = !isOwn(existing) && inStretch(existing.step, from, point.step, wrap);
            if (drop) {
                removed?.push(existing);
            }
            return drop;
        });
    }
    const low = lowerBound(points, point.step);
    const same = points[low];
    if (same && same.step === point.step) {
        if (removed && !isOwn(same)) {
            removed.push(same);
        }
        points.splice(low, 1, point);
    } else {
        points.splice(low, 0, point);
    }
    return point;
};

/** The index of the first point at or after `step` in sorted points. */
const lowerBound = (points: readonly AutomationPoint[], step: number): number => {
    let low = 0;
    let high = points.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (points[mid]!.step < step) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
};

/* ---- holds at a gesture's ends ---- */

/**
 * How far before a gesture's first point (and after its last) a hold point keeps the old curve: 1/256 step, half a
 * millisecond at 120 BPM. Two points never share a step, so the recording cannot take over at the very same position.
 */
export const HOLD_GAP = 1 / 256;

/**
 * The lane points a take put in: those it recorded (`own`: a later gesture of the take does not write over them, replace
 * does not clear them) and the hold points (they sit on the old curve, so both may remove them). `raw` unwraps a
 * point read through a reactive proxy (Vue's `toRaw`), so identity holds.
 */
export class TakePoints {
    private readonly own = new WeakSet<AutomationPoint>();
    private readonly holds = new WeakSet<AutomationPoint>();

    constructor(private readonly raw: (point: AutomationPoint) => AutomationPoint = (point) => point) {}

    readonly isOwn = (point: AutomationPoint): boolean => this.own.has(this.raw(point));
    readonly isHold = (point: AutomationPoint): boolean => this.holds.has(this.raw(point));
    /** Whether the take put the point in, recorded or hold: at most `CC_MAX_PER_STEP` of those share a step. */
    readonly isTake = (point: AutomationPoint): boolean => this.isOwn(point) || this.isHold(point);

    addOwn(point: AutomationPoint): void {
        this.own.add(this.raw(point));
    }

    addHold(point: AutomationPoint): void {
        this.holds.add(this.raw(point));
    }

    unwrap(point: AutomationPoint): AutomationPoint {
        return this.raw(point);
    }
}

/** How many of the points in the step holding `step` the take put in. */
const takePointsInStep = (points: readonly AutomationPoint[], step: number, take: TakePoints): number => {
    const index = Math.floor(step);
    let count = 0;
    for (let i = lowerBound(points, index); i < points.length && points[i]!.step < index + 1; i++) {
        if (take.isTake(points[i]!)) {
            count++;
        }
    }
    return count;
};

/** One gesture on a lane: its points (recorded and holds), the old points it wrote over and its last recorded point. */
class Gesture {
    private readonly members = new WeakSet<AutomationPoint>();
    readonly removed: AutomationPoint[] = [];
    last: AutomationPoint | null = null;
    wrap: LaneWrap | undefined;

    constructor(private readonly take: TakePoints) {}

    has(point: AutomationPoint): boolean {
        return this.members.has(this.take.unwrap(point));
    }

    add(point: AutomationPoint): void {
        this.members.add(this.take.unwrap(point));
    }
}

/**
 * Writes one controller's recorded points into one lane, a gesture at a time (touch style: see `writeRecordedPoint`),
 * and keeps the lane's old curve intact around each gesture:
 * - Before its first point a `hold` point at `HOLD_GAP` ahead of it carries the curve's value there, so the curve is as
 *   it was right up to the gesture, which then takes over with a jump (not the old curve ramping into the first
 *   recorded point). None is needed where the segment already holds, in front of an empty lane, at the lane's start,
 *   in a step replace mode cleared (`isCleared`: no old curve left), or in a step that holds the most points already.
 * - When the gesture ends (`finish`: the next gesture starts, or the take ends) and old points follow it, a point at
 *   `HOLD_GAP` after its last (at most at `wrap.end`) carries the old curve's value there, with the shape of the old
 *   segment it splits, so the old curve goes on as it was instead of ramping from the recorded end value into its next
 *   point. Nothing old following: the recorded end value holds, as before. Not in a cleared step; in a full step it
 *   takes the place of the gesture's point before the last.
 * - A gesture across `wrap`'s end, where the lane goes on past it (a song lane's loop region): the old curve after the
 *   end gets a point at the end, the curve before the start a hold as before a first point, and the start a point
 *   with the value the gesture had at the wrap (recorded, the take's own), so the region's start plays the gesture
 *   and what lies outside the region plays as it did.
 * The holds are not the take's own points: a later gesture writes over them and replace clears them like old points.
 * Splitting a straight or holding segment keeps it exactly; a bent one stays close.
 */
export class LaneWriter {
    private gesture: Gesture | null = null;

    constructor(
        readonly points: AutomationPoint[],
        private readonly take: TakePoints,
        private readonly isCleared: (position: number) => boolean = () => false,
    ) {}

    /**
     * Writes a recorded point. `from` is the position of the same gesture's previous point; null starts a gesture (the
     * one before is finished first). Returns the points it put in besides `point` (holds, the start of a wrapped
     * region), so the caller can count those in `point`'s step.
     */
    write(point: AutomationPoint, from: number | null, wrap?: LaneWrap): AutomationPoint[] {
        const added: AutomationPoint[] = [];
        const keep = (extra: AutomationPoint | null): void => {
            if (extra) {
                this.gesture!.add(extra);
                added.push(extra);
            }
        };
        if (from === null || !this.gesture) {
            this.finish();
            this.gesture = new Gesture(this.take);
            keep(this.holdBefore(point.step));
            from = null;
        }
        const gesture = this.gesture;
        const wrapped = from !== null && from > point.step && wrap ? gesture.last : null;
        // A region that starts later than the lane (a song's loop region): the curve before it stays as it is (taken
        // before the gesture writes over the region's start).
        const region = wrapped && wrap!.start > 0;
        if (region) {
            keep(this.holdBefore(wrap!.start));
        }
        writeRecordedPoint(this.points, point, from, this.take.isOwn, wrap, gesture.removed);
        this.take.addOwn(point);
        gesture.add(point);
        if (wrapped) {
            // The old curve after the region's end goes on as it was; the region starts where the gesture was at the wrap.
            keep(this.holdAfter(gesture, wrapped, wrap!.end));
            if (region) {
                keep(this.startAt(gesture, wrap!.start, wrapped.value));
            }
        }
        gesture.last = point;
        gesture.wrap = wrap;
        return added;
    }

    /** Ends the current gesture; returns the hold put in after its last point, or null. */
    finish(): AutomationPoint | null {
        const gesture = this.gesture;
        this.gesture = null;
        if (!gesture?.last) {
            return null;
        }
        const end = gesture.wrap?.end ?? Number.POSITIVE_INFINITY;
        return this.holdAfter(gesture, gesture.last, Math.min(gesture.last.step + HOLD_GAP, end));
    }

    /** A hold at `HOLD_GAP` before `position` with the lane's value there, when the lane needs one (see the class). */
    private holdBefore(position: number): AutomationPoint | null {
        const points = this.points;
        const at = position - HOLD_GAP;
        if (!points.length || at < 0 || this.isCleared(at)) {
            return null;
        }
        const index = lowerBound(points, at);
        if (index < points.length && points[index]!.step < position) {
            // A point right before already ends the curve there.
            return null;
        }
        if (points[index - 1]?.shape === 'hold') {
            return null;
        }
        const room = Math.floor(at) === Math.floor(position) ? CC_MAX_PER_STEP - 1 : CC_MAX_PER_STEP;
        if (takePointsInStep(points, at, this.take) >= room) {
            return null;
        }
        const hold: AutomationPoint = { step: at, value: valueAt(points, at)!, shape: 'hold' };
        points.splice(index, 0, hold);
        this.take.addHold(hold);
        return hold;
    }

    /** A point at `at` (just after the gesture's point `last`) with the old curve's value there, when old points follow. */
    private holdAfter(gesture: Gesture, last: AutomationPoint, at: number): AutomationPoint | null {
        const points = this.points;
        if (this.isCleared(at)) {
            return null;
        }
        // The old curve around `at`: the lane without the gesture's points, plus the old points it wrote over.
        let before: AutomationPoint | null = null;
        let after: AutomationPoint | null = null;
        const consider = (point: AutomationPoint): void => {
            if (gesture.has(point)) {
                return;
            }
            if (point.step <= at) {
                if (!before || point.step >= before.step) {
                    before = point;
                }
            } else if (!after || point.step < after.step) {
                after = point;
            }
        };
        const lastIndex = lowerBound(points, last.step);
        for (let i = 0; i < points.length; i++) {
            const point = points[i]!;
            if (i > lastIndex && point.step <= at && !gesture.has(point)) {
                // An old point right after the gesture already carries the old curve on.
                return null;
            }
            consider(point);
        }
        for (const point of gesture.removed) {
            consider(point);
        }
        const start = before as AutomationPoint | null;
        const next = after as AutomationPoint | null;
        if (!next) {
            return null;
        }
        if (takePointsInStep(points, at, this.take) >= CC_MAX_PER_STEP) {
            const previous = points[lastIndex - 1];
            if (Math.floor(at) !== Math.floor(last.step) || !previous || Math.floor(previous.step) !== Math.floor(last.step) || !gesture.has(previous) || this.take.isHold(previous)) {
                return null;
            }
            points.splice(lastIndex - 1, 1);
        }
        const hold: AutomationPoint = {
            step: at,
            value: start ? segmentValue(start, next, at) : next.value,
            ...(start?.shape ? { shape: start.shape } : {}),
            ...(start?.tension ? { tension: start.tension } : {}),
        };
        points.splice(lowerBound(points, at), 0, hold);
        this.take.addHold(hold);
        return hold;
    }

    /**
     * A recorded point at a wrapped region's start with the gesture's value at the wrap. The gesture's own from an earlier
     * wrap takes the new value; another point there stays.
     */
    private startAt(gesture: Gesture, start: number, value: number): AutomationPoint | null {
        const points = this.points;
        const index = lowerBound(points, start);
        const there = points[index];
        if (there?.step === start) {
            if (gesture.has(there) && this.take.isOwn(there)) {
                there.value = value;
            }
            return null;
        }
        const point: AutomationPoint = { step: start, value };
        points.splice(index, 0, point);
        this.take.addOwn(point);
        return point;
    }
}

/** Replace mode: removes the points in pattern step `[step, step + 1)` of a lane, except the take's own. */
export const clearLaneStep = (points: AutomationPoint[], step: number, isOwn: (point: AutomationPoint) => boolean): void => {
    removeWhere(points, (point) => !isOwn(point) && point.step >= step && point.step < step + 1);
};

/* ---- song lanes ---- */

/**
 * The song steps a replace take has cleared (song mode, for the song lanes it records): each one the first time the
 * take plays it; when the loop region comes round again, the take overdubs.
 */
export class SongReplacePass {
    private readonly cleared = new Set<number>();

    /** Marks a song step as cleared. True when it was not yet (the caller clears it now). */
    claim(step: number): boolean {
        const index = Math.floor(step);
        if (this.cleared.has(index)) {
            return false;
        }
        this.cleared.add(index);
        return true;
    }

    /** Whether the song step holding `step` was cleared. */
    has(step: number): boolean {
        return this.cleared.has(Math.floor(step));
    }

    /** The steps cleared so far, for a lane that joins the take late. */
    clearedSteps(): number[] {
        return [...this.cleared];
    }
}

/** What `songLaneFor` needs of the song: its lanes (the reactive proxy, so the view sees the new lane) and adding one. */
export interface SongLanes {
    readonly automation: SongAutomationLane[];
    addAutomation(target: AutomationTarget, param: string): SongAutomationLane;
}

/**
 * The song lane that records a parameter: the first lane driving it, or a new one. A new lane holds `initial` (the
 * parameter's value when the take began) from the song's start until the first recorded point (a `hold` point at
 * step 0, returned as `start` so the take can count it as its own), so the part of the song before the controller moved
 * sounds as it did.
 */
export const songLaneFor = (song: SongLanes, target: AutomationTarget, param: string, initial: number): { lane: SongAutomationLane; start: AutomationPoint | null } => {
    const find = () => song.automation.find((lane) => lane.param === param && sameTarget(lane.target, target));
    const existing = find();
    if (existing) {
        return { lane: existing, start: null };
    }
    song.addAutomation({ ...target }, param);
    const lane = find()!;
    const start: AutomationPoint = { step: 0, value: Math.min(1, Math.max(0, initial)), shape: 'hold' };
    lane.points.push(start);
    return { lane, start };
};
