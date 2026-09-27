import type { BaseContext } from 'tone';
import { createId } from './audio';

/**
 * Automation: every value a user can turn can also be driven over time.
 *
 * Two kinds of lanes exist. A track keeps step lanes (`TrackAutomation`): one value per step of its
 * pattern, drawn like velocity and looping with the pattern. The song keeps breakpoint lanes
 * (`SongAutomationLane`): points on the arrangement's timeline, interpolated in between, that can drive
 * any track, container bus or the master.
 *
 * Lanes store positions between 0 and 1 rather than real values, so a lane does not care what it drives.
 * `toValue` and `toNormalized` translate with the parameter's own range and curve, the same way its knob does.
 */

/** One value a user can turn and automation can drive: its address, range and how it reads. */
export interface AutomationParam {
    /** Address inside its owner, e.g. `volume`, `envelope.attack`, `fx.reverb.wet`. */
    key: string;
    label: string;
    /** Where the value belongs, for grouping in menus: `Mix`, `Synth`, the name of an effect, ... */
    group: string;
    min: number;
    max: number;
    step: number;
    /** `log` spreads small values out, which suits times and frequencies. */
    curve?: 'linear' | 'log';
    format?: (value: number) => string;
}

/** Anything with parameters automation can drive: tracks and buses. */
export interface Automatable {
    readonly parameters: readonly AutomationParam[];
    getParameter(key: string): number;
    /**
     * Sets a parameter. `time` is the audio-context time to apply it at: the sequencer runs ahead of
     * what you hear, so automation is scheduled, while a user turning a knob wants it now.
     */
    setParameter(key: string, value: number, time?: number): void;
}

const formatDecibel = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
const formatPan = (value: number) => (Math.abs(value) < 0.005 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`);

/** Level and pan, the two things every channel has. */
export const MIX_PARAMS: readonly AutomationParam[] = [
    { key: 'volume', label: 'Volume', group: 'Mix', min: -40, max: 6, step: 0.1, format: formatDecibel },
    { key: 'pan', label: 'Pan', group: 'Mix', min: -1, max: 1, step: 0.01, format: formatPan },
];

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
const isLog = (param: AutomationParam): boolean => param.curve === 'log' && param.min > 0;

/** Where a value sits inside a parameter's range, 0..1, the way its knob shows it. */
export const toNormalized = (param: AutomationParam, value: number): number => {
    const v = Math.min(param.max, Math.max(param.min, value));
    if (isLog(param)) {
        return clamp01(Math.log(v / param.min) / Math.log(param.max / param.min));
    }
    return clamp01((v - param.min) / (param.max - param.min));
};

/** The real value for a position 0..1 inside a parameter's range, snapped to the parameter's step. */
export const toValue = (param: AutomationParam, position: number): number => {
    const t = clamp01(position);
    const raw = isLog(param) ? param.min * Math.pow(param.max / param.min, t) : param.min + t * (param.max - param.min);
    const decimals = Math.max(0, Math.ceil(-Math.log10(param.step)));
    const quantized = parseFloat((Math.round(raw / param.step) * param.step).toFixed(decimals));
    return Math.min(param.max, Math.max(param.min, quantized));
};

/** How a parameter reads in a menu: level and pan on their own, everything else with its group in front. */
export const paramTitle = (param: AutomationParam): string => (param.group === 'Mix' ? param.label : `${param.group} · ${param.label}`);

/** A readable version of a normalized position, for a parameter. */
export const formatValue = (param: AutomationParam, position: number): string => {
    const value = toValue(param, position);
    return param.format ? param.format(value) : `${value}`;
};

/** Runs `fn` at an audio-context time, or right away when no time is given. For values that cannot be scheduled. */
export const atTime = (context: BaseContext, time: number | undefined, fn: () => void): void => {
    const delay = time === undefined ? 0 : time - context.currentTime;
    if (delay <= 0) {
        fn();
    } else {
        context.setTimeout(fn, delay);
    }
};

/* ---- points: the same curve in both views ---- */

/**
 * How a segment travels from one point to the next:
 * - `curve` bends towards either end: slow start and fast finish, or the other way round (a straight line at tension 0)
 * - `s-curve` shapes both ends at once: easing in and out, or rushing at both ends with a flat middle
 * - `hold` keeps the value until the next point, then jumps
 */
export type CurveShape = 'curve' | 's-curve' | 'hold';

export const CURVE_SHAPES: readonly { key: CurveShape; label: string; icon: string }[] = [
    { key: 'curve', label: 'Curve', icon: 'mdi:vector-curve' },
    { key: 's-curve', label: 'S-curve', icon: 'mdi:sine-wave' },
    { key: 'hold', label: 'Hold', icon: 'mdi:stairs' },
];

export interface AutomationPoint {
    step: number;
    /** 0..1 */
    value: number;
    /** The shape of the segment from this point to the next. Missing means `curve`. */
    shape?: CurveShape;
    /** How strongly that segment bends, -1..1. Missing or 0 is straight (for `curve` and `s-curve`). */
    tension?: number;
}

/** Anything that carries a curve: a track's step lane or a song lane. */
export interface AutomationCurve {
    /** Sorted by step; never two points on one step. */
    readonly points: AutomationPoint[];
}

/** The strongest bend: at tension ±1 a segment follows t^8. */
const MAX_EXPONENT = 8;

/**
 * Where a segment is (0..1 of the way from its start value to its end value) at `t`, 0..1 of the way along it.
 * Positive tension holds back at the start (curve) or at both ends (s-curve); negative tension rushes there instead.
 */
export const segmentProgress = (t: number, shape: CurveShape = 'curve', tension = 0): number => {
    const x = Math.min(1, Math.max(0, t));
    if (shape === 'hold') {
        return x < 1 ? 0 : 1;
    }
    const k = Math.max(-1, Math.min(1, tension));
    if (k === 0) {
        return x;
    }
    const e = Math.pow(MAX_EXPONENT, Math.abs(k));
    if (shape === 's-curve') {
        if (k > 0) {
            return x < 0.5 ? 0.5 * Math.pow(2 * x, e) : 1 - 0.5 * Math.pow(2 - 2 * x, e);
        }
        return x < 0.5 ? 0.5 * (1 - Math.pow(1 - 2 * x, e)) : 0.5 + 0.5 * Math.pow(2 * x - 1, e);
    }
    return k > 0 ? Math.pow(x, e) : 1 - Math.pow(1 - x, e);
};

/** The value of the segment that starts at `from` and ends at `to`, at a step between them. */
export const segmentValue = (from: AutomationPoint, to: AutomationPoint, step: number): number => {
    const span = to.step - from.step;
    if (span <= 0) {
        return to.value;
    }
    return from.value + segmentProgress((step - from.step) / span, from.shape, from.tension) * (to.value - from.value);
};

/** The curve's value at a step (each segment shaped by its start point, flat before the first and after the last), or null without points. */
export const valueAt = (points: readonly AutomationPoint[], step: number): number | null => {
    if (!points.length) {
        return null;
    }
    const first = points[0]!;
    if (step <= first.step) {
        return first.value;
    }
    for (let i = 1; i < points.length; i++) {
        const next = points[i]!;
        if (step <= next.step) {
            return segmentValue(points[i - 1]!, next, step);
        }
    }
    return points[points.length - 1]!.value;
};

/** Sets the shape and tension of the segment that starts at a point. Tension 0 on a curve is stored as nothing, a plain line. */
export const setSegment = (curve: AutomationCurve, index: number, shape: CurveShape, tension: number): void => {
    const point = curve.points[index];
    if (!point) {
        return;
    }
    const k = Math.round(Math.max(-1, Math.min(1, tension)) * 100) / 100;
    if (shape === 'curve') {
        delete point.shape;
    } else {
        point.shape = shape;
    }
    if (k === 0 || shape === 'hold') {
        delete point.tension;
    } else {
        point.tension = k;
    }
};

const sortPoints = (curve: AutomationCurve): void => {
    curve.points.sort((a, b) => a.step - b.step);
};

/** Places a point, replacing any point already on that step. Returns its index. */
export const setPoint = (curve: AutomationCurve, step: number, value: number): number => {
    const at = Math.max(0, Math.round(step));
    const clamped = clamp01(value);
    const existing = curve.points.find((point) => point.step === at);
    if (existing) {
        existing.value = clamped;
    } else {
        // A point dropped into a shaped segment splits it: both halves keep the segment's shape.
        const before = [...curve.points].reverse().find((point) => point.step < at);
        const splits = before && curve.points.some((point) => point.step > at);
        curve.points.push({
            step: at,
            value: clamped,
            ...(splits && before.shape ? { shape: before.shape } : {}),
            ...(splits && before.tension ? { tension: before.tension } : {}),
        });
        sortPoints(curve);
    }
    return curve.points.findIndex((point) => point.step === at);
};

/** Moves a point to another step and value. It cannot land on a neighbour; it stops next to it. Returns the new index. */
export const movePoint = (curve: AutomationCurve, index: number, step: number, value: number): number => {
    const point = curve.points[index];
    if (!point) {
        return index;
    }
    const previous = curve.points[index - 1];
    const next = curve.points[index + 1];
    const low = previous ? previous.step + 1 : 0;
    const high = next ? next.step - 1 : Number.POSITIVE_INFINITY;
    point.step = Math.min(high, Math.max(low, Math.round(step)));
    point.value = clamp01(value);
    return index;
};

export const removePoint = (curve: AutomationCurve, index: number): void => {
    if (index >= 0 && index < curve.points.length) {
        curve.points.splice(index, 1);
    }
};

/* ---- step lanes (track view) ---- */

/** A curve over a track's pattern, for one parameter. Its steps run from 0 to the pattern's length. */
export interface StepAutomationLane extends AutomationCurve {
    readonly id: string;
    param: string;
}

export interface StepAutomationSnapshot {
    param: string;
    points: AutomationPoint[];
}

/** The step lanes of one track. Keeps them inside the pattern's length. */
export class TrackAutomation {
    readonly lanes: StepAutomationLane[] = [];

    constructor(private length: number) {}

    laneFor(param: string): StepAutomationLane | undefined {
        return this.lanes.find((lane) => lane.param === param);
    }

    /** Adds a lane for a parameter, flat at `initial` (one point at the start). A parameter has one lane at most; an existing one is returned. */
    add(param: string, initial = 0.5): StepAutomationLane {
        const existing = this.laneFor(param);
        if (existing) {
            return existing;
        }
        const lane: StepAutomationLane = { id: createId(), param, points: [{ step: 0, value: clamp01(initial) }] };
        this.lanes.push(lane);
        return lane;
    }

    remove(id: string): void {
        const index = this.lanes.findIndex((lane) => lane.id === id);
        if (index !== -1) {
            this.lanes.splice(index, 1);
        }
    }

    /** Follows the pattern's length: points past the end are dropped, the last of them lands on the last step so the curve keeps its end. */
    resize(length: number): void {
        this.length = length;
        for (const lane of this.lanes) {
            const beyond = lane.points.filter((point) => point.step >= length);
            if (!beyond.length) {
                continue;
            }
            lane.points.splice(lane.points.length - beyond.length, beyond.length);
            const last = length - 1;
            if (!lane.points.some((point) => point.step === last)) {
                lane.points.push({ step: last, value: beyond[0]!.value });
            }
        }
    }

    copyFrom(other: TrackAutomation): void {
        this.lanes.splice(0);
        for (const lane of other.lanes) {
            this.lanes.push({ id: createId(), param: lane.param, points: lane.points.map((point) => ({ ...point })) });
        }
        this.resize(this.length);
    }

    serialize(): StepAutomationSnapshot[] {
        return this.lanes.map((lane) => ({ param: lane.param, points: lane.points.map((point) => ({ ...point })) }));
    }

    /** Replaces the lanes with a snapshot's, keeping the ids of lanes that are still there. */
    restore(lanes: readonly StepAutomationSnapshot[]): void {
        const kept = lanes.map((lane) => ({ id: this.laneFor(lane.param)?.id ?? createId(), param: lane.param, points: lane.points.map((point) => ({ ...point })) }));
        this.lanes.splice(0, this.lanes.length, ...kept);
        this.resize(this.length);
    }
}

/* ---- breakpoint lanes (song view) ---- */

/** What a song lane drives. */
export type AutomationTarget = { kind: 'master' } | { kind: 'container'; containerId: string } | { kind: 'track'; containerId: string; trackId: string };

/** A parameter of the master, a container or a track, drawn over the song's timeline. */
export interface SongAutomationLane extends AutomationCurve {
    readonly id: string;
    target: AutomationTarget;
    param: string;
}

export const createSongLane = (target: AutomationTarget, param: string, id = createId()): SongAutomationLane => ({ id, target, param, points: [] });

export const sameTarget = (a: AutomationTarget, b: AutomationTarget): boolean =>
    a.kind === b.kind &&
    (a.kind === 'master' || a.containerId === (b as { containerId: string }).containerId) &&
    (a.kind !== 'track' || a.trackId === (b as { trackId: string }).trackId);
