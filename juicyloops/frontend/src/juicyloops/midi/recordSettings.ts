/**
 * The recorder's toggles, kept per browser in localStorage (not in the session: they are how this person records,
 * not part of the song).
 */
export interface RecordSettings {
    /** Replace what the first pass of a take plays over (armed tracks only); off overdubs. */
    replace: boolean;
    /** One bar of clicks before the transport starts. */
    countIn: boolean;
    /** Clicks while recording. */
    metronome: boolean;
    /** Clicks whenever the transport plays, recording or not. */
    metronomeWhilePlaying: boolean;
    /** Shifts recorded notes and controller moves by this many ms (positive later, negative earlier). */
    offsetMs: number;
}

export const DEFAULT_RECORD_SETTINGS: Readonly<RecordSettings> = Object.freeze({
    replace: false,
    countIn: true,
    metronome: true,
    metronomeWhilePlaying: false,
    offsetMs: 0,
});

/** The offset range the setting allows. */
export const MAX_RECORD_OFFSET_MS = 250;

const KEY = 'juicyloops:record';

export const clampOffset = (ms: number): number => (Number.isFinite(ms) ? Math.max(-MAX_RECORD_OFFSET_MS, Math.min(MAX_RECORD_OFFSET_MS, Math.round(ms))) : 0);

/** The stored settings, each missing or broken one at its default. */
export const readRecordSettings = (): RecordSettings => {
    let stored: Partial<RecordSettings> = {};
    try {
        const raw = globalThis.localStorage?.getItem(KEY);
        stored = raw ? (JSON.parse(raw) as Partial<RecordSettings>) : {};
    } catch {
        stored = {};
    }
    const flag = (key: Exclude<keyof RecordSettings, 'offsetMs'>): boolean => (typeof stored[key] === 'boolean' ? stored[key] : DEFAULT_RECORD_SETTINGS[key]);
    return {
        replace: flag('replace'),
        countIn: flag('countIn'),
        metronome: flag('metronome'),
        metronomeWhilePlaying: flag('metronomeWhilePlaying'),
        offsetMs: clampOffset(typeof stored.offsetMs === 'number' ? stored.offsetMs : DEFAULT_RECORD_SETTINGS.offsetMs),
    };
};

export const writeRecordSettings = (settings: RecordSettings): void => {
    try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...settings, offsetMs: clampOffset(settings.offsetMs) }));
    } catch {
        /* private mode or blocked storage: the settings simply do not persist */
    }
};
