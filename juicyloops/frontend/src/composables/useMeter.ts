import { markRaw, onBeforeUnmount, shallowRef, watch, type Ref } from 'vue';
import { Meter, type ToneAudioNode } from 'tone';

/**
 * Level meters for the mixer strips and the device rack.
 *
 * A meter is an analyser tapped after a channel's fader. It exists only while its strip is on screen: created on mount,
 * disconnected and disposed on unmount, so a closed mixer costs nothing. All meters are read in one shared
 * animation frame loop that stops when the last one goes.
 */

export interface MeterReading {
    /** Level per channel (left, right) in dB, -Infinity for silence. */
    levels: [number, number];
    /** The loudest level of the last moments, per channel, in dB: the peak-hold line. */
    peaks: [number, number];
    /** True for a while after a channel went over 0 dB. */
    clipped: boolean;
}

const SILENT: MeterReading = { levels: [-Infinity, -Infinity], peaks: [-Infinity, -Infinity], clipped: false };

/** How long the peak line holds before it falls, and how fast it falls (dB per second). */
const PEAK_HOLD_MS = 1200;
const PEAK_FALL_DB_PER_S = 20;
const CLIP_HOLD_MS = 2000;

interface Subscriber {
    meter: Meter;
    reading: Ref<MeterReading>;
    peakAt: [number, number];
    clipAt: number;
}

const subscribers = new Set<Subscriber>();
let frame = 0;
let lastTime = 0;

const tick = (now: number) => {
    const elapsed = lastTime ? (now - lastTime) / 1000 : 0;
    lastTime = now;
    for (const sub of subscribers) {
        const raw = sub.meter.getValue();
        const values = (Array.isArray(raw) ? raw : [raw, raw]) as number[];
        const previous = sub.reading.value;
        const levels: [number, number] = [values[0] ?? -Infinity, values[1] ?? values[0] ?? -Infinity];
        const peaks: [number, number] = [previous.peaks[0], previous.peaks[1]];
        for (let channel = 0; channel < 2; channel++) {
            const level = levels[channel]!;
            if (level >= peaks[channel]! || !Number.isFinite(peaks[channel]!)) {
                peaks[channel] = level;
                sub.peakAt[channel] = now;
            } else if (now - sub.peakAt[channel]! > PEAK_HOLD_MS) {
                peaks[channel] = Math.max(level, peaks[channel]! - PEAK_FALL_DB_PER_S * elapsed);
            }
        }
        if (levels[0] > 0 || levels[1] > 0) {
            sub.clipAt = now;
        }
        const clipped = now - sub.clipAt < CLIP_HOLD_MS;
        // Nothing to redraw for a strip that stays silent.
        if (previous.levels[0] === levels[0] && previous.levels[1] === levels[1] && previous.peaks[0] === peaks[0] && previous.clipped === clipped) {
            continue;
        }
        sub.reading.value = { levels, peaks, clipped };
    }
    frame = subscribers.size ? requestAnimationFrame(tick) : 0;
};

const subscribe = (sub: Subscriber) => {
    subscribers.add(sub);
    if (!frame) {
        lastTime = 0;
        frame = requestAnimationFrame(tick);
    }
};

/**
 * A live reading of a channel's level. `source` is the node to tap (a channel's `meterSource`); when it changes, the
 * meter moves with it. The reading is silent while there is no source.
 */
export const useMeter = (source: Ref<ToneAudioNode | null>): Ref<MeterReading> => {
    const reading = shallowRef<MeterReading>(SILENT);
    let current: { sub: Subscriber; source: ToneAudioNode } | null = null;

    const detach = () => {
        if (!current) {
            return;
        }
        subscribers.delete(current.sub);
        try {
            current.source.disconnect(current.sub.meter);
        } catch {
            /* the source was disposed with its channel */
        }
        current.sub.meter.dispose();
        current = null;
        reading.value = SILENT;
    };

    watch(
        source,
        (node) => {
            detach();
            if (!node) {
                return;
            }
            const meter = markRaw(new Meter({ channelCount: 2, smoothing: 0.7 }));
            node.connect(meter);
            const sub: Subscriber = { meter, reading, peakAt: [0, 0], clipAt: -Infinity };
            current = { sub, source: node };
            subscribe(sub);
        },
        { immediate: true },
    );

    onBeforeUnmount(detach);
    return reading;
};

/** Where a level sits on a meter's scale, 0..1: -60 dB at the bottom, +6 at the top, with more room near 0 dB. */
export const meterPosition = (db: number): number => {
    if (!Number.isFinite(db) || db <= -60) {
        return 0;
    }
    const clamped = Math.min(6, db);
    // A gentle power curve spends more of the height on the loud end, where mixing happens.
    return Math.pow((clamped + 60) / 66, 1.6);
};
