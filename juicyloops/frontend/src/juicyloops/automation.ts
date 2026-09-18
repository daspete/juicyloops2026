import { getContext } from 'tone';
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
export const atTime = (time: number | undefined, fn: () => void): void => {
    const delay = time === undefined ? 0 : time - getContext().currentTime;
    if (delay <= 0) {
        fn();
    } else {
        getContext().setTimeout(fn, delay);
    }
};

/* ---- step lanes (track view) ---- */

/** One value per step of a track's pattern, 0..1, for one parameter. */
export interface StepAutomationLane {
    readonly id: string;
    param: string;
    /** As many entries as the track has steps. */
    values: number[];
}

export interface StepAutomationSnapshot {
    param: string;
    values: number[];
}

/** The step lanes of one track. Keeps them as long as the pattern. */
export class TrackAutomation {
    readonly lanes: StepAutomationLane[] = [];

    constructor(private length: number) {}

    laneFor(param: string): StepAutomationLane | undefined {
        return this.lanes.find((lane) => lane.param === param);
    }

    /** Adds a lane for a parameter, flat at `initial`. A parameter has one lane at most; an existing one is returned. */
    add(param: string, initial = 0.5): StepAutomationLane {
        const existing = this.laneFor(param);
        if (existing) {
            return existing;
        }
        const lane: StepAutomationLane = { id: createId(), param, values: Array.from({ length: this.length }, () => clamp01(initial)) };
        this.lanes.push(lane);
        return lane;
    }

    remove(id: string): void {
        const index = this.lanes.findIndex((lane) => lane.id === id);
        if (index !== -1) {
            this.lanes.splice(index, 1);
        }
    }

    /** Follows the pattern's length: new steps continue the last value, removed ones are gone. */
    resize(length: number): void {
        this.length = length;
        for (const lane of this.lanes) {
            if (lane.values.length > length) {
                lane.values.splice(length);
            } else {
                const last = lane.values[lane.values.length - 1] ?? 0.5;
                while (lane.values.length < length) {
                    lane.values.push(last);
                }
            }
        }
    }

    copyFrom(other: TrackAutomation): void {
        this.lanes.splice(0);
        for (const lane of other.lanes) {
            this.lanes.push({ id: createId(), param: lane.param, values: [...lane.values] });
        }
        this.resize(this.length);
    }

    serialize(): StepAutomationSnapshot[] {
        return this.lanes.map((lane) => ({ param: lane.param, values: [...lane.values] }));
    }
}

/* ---- breakpoint lanes (song view) ---- */

/** What a song lane drives. */
export type AutomationTarget = { kind: 'master' } | { kind: 'container'; containerId: string } | { kind: 'track'; containerId: string; trackId: string };

export interface AutomationPoint {
    step: number;
    /** 0..1 */
    value: number;
}

/** A parameter drawn over the song's timeline: straight lines between points, flat before the first and after the last. */
export interface SongAutomationLane {
    readonly id: string;
    target: AutomationTarget;
    param: string;
    /** Sorted by step; never two points on one step. */
    readonly points: AutomationPoint[];
}

export const createSongLane = (target: AutomationTarget, param: string): SongAutomationLane => ({ id: createId(), target, param, points: [] });

export const sameTarget = (a: AutomationTarget, b: AutomationTarget): boolean =>
    a.kind === b.kind &&
    (a.kind === 'master' || a.containerId === (b as { containerId: string }).containerId) &&
    (a.kind !== 'track' || a.trackId === (b as { trackId: string }).trackId);

/** The lane's value at a step, or null when it has no points yet. */
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
            const previous = points[i - 1]!;
            const span = next.step - previous.step;
            return span === 0 ? next.value : previous.value + ((step - previous.step) / span) * (next.value - previous.value);
        }
    }
    return points[points.length - 1]!.value;
};

const sortPoints = (lane: SongAutomationLane): void => {
    lane.points.sort((a, b) => a.step - b.step);
};

/** Places a point, replacing any point already on that step. Returns its index. */
export const setPoint = (lane: SongAutomationLane, step: number, value: number): number => {
    const at = Math.max(0, Math.round(step));
    const clamped = clamp01(value);
    const existing = lane.points.find((point) => point.step === at);
    if (existing) {
        existing.value = clamped;
    } else {
        lane.points.push({ step: at, value: clamped });
        sortPoints(lane);
    }
    return lane.points.findIndex((point) => point.step === at);
};

/** Moves a point to another step and value. It cannot land on a neighbour; it stops next to it. Returns the new index. */
export const movePoint = (lane: SongAutomationLane, index: number, step: number, value: number): number => {
    const point = lane.points[index];
    if (!point) {
        return index;
    }
    const previous = lane.points[index - 1];
    const next = lane.points[index + 1];
    const low = previous ? previous.step + 1 : 0;
    const high = next ? next.step - 1 : Number.POSITIVE_INFINITY;
    point.step = Math.min(high, Math.max(low, Math.round(step)));
    point.value = clamp01(value);
    return index;
};

export const removePoint = (lane: SongAutomationLane, index: number): void => {
    if (index >= 0 && index < lane.points.length) {
        lane.points.splice(index, 1);
    }
};
