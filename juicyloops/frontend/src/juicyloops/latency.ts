/**
 * The "low latency" setting: whether the audio context is made for playing live (`latencyHint: 'interactive'`, the
 * default) or for steady playback with a bigger output buffer (`'balanced'`). A context's latency is fixed when it is
 * made, so the setting is read once when `engine.ts` loads and a change takes effect on the next start of the app.
 * Scheduled notes do not care: they are sent `LOOK_AHEAD_SECONDS` ahead either way. Live (MIDI) notes do.
 */

export type LatencyHint = 'interactive' | 'balanced';

const LOW_LATENCY_KEY = 'juicyloops:lowLatency';

/** The stored setting; on unless it was turned off (or storage is blocked: then the default). */
export const readLowLatency = (): boolean => {
    try {
        return globalThis.localStorage?.getItem(LOW_LATENCY_KEY) !== 'false';
    } catch {
        return true;
    }
};

export const writeLowLatency = (low: boolean): void => {
    try {
        globalThis.localStorage?.setItem(LOW_LATENCY_KEY, String(low));
    } catch {
        /* private mode or blocked storage: the choice simply does not persist */
    }
};

export const latencyHintFor = (low: boolean): LatencyHint => (low ? 'interactive' : 'balanced');
