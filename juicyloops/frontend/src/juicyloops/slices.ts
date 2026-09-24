/**
 * Slicing a sample: cut points inside the played region split it into parts that can be played on their own.
 *
 * Cuts are stored in seconds of the original sample, so trimming the region, changing the pitch or the speed
 * never moves them. Only the cuts inside the region count; one outside it is kept (move the region back and it
 * is there again) but plays no part.
 */

export interface SliceRange {
    start: number;
    end: number;
}

/** Most slices a sample can have: one per semitone over three octaves of the piano roll. */
export const MAX_SLICES = 36;

/** A slice shorter than this (seconds) is not worth a key; cuts closer together than that are merged. */
export const MIN_SLICE_SECONDS = 0.01;

/** The cuts sorted, deduplicated, and without the ones too close to a neighbour. */
export const normalizeCuts = (cuts: readonly number[]): number[] => {
    const sorted = cuts.filter((cut) => Number.isFinite(cut) && cut >= 0).sort((a, b) => a - b);
    const result: number[] = [];
    for (const cut of sorted) {
        if (!result.length || cut - result[result.length - 1]! >= MIN_SLICE_SECONDS) {
            result.push(cut);
        }
    }
    return result;
};

/** The parts `cuts` split the region `start .. end` into, in order. No cuts inside the region means one part: the region. */
export const sliceRanges = (start: number, end: number, cuts: readonly number[]): SliceRange[] => {
    const inside = cuts.filter((cut) => cut - start >= MIN_SLICE_SECONDS && end - cut >= MIN_SLICE_SECONDS).slice(0, MAX_SLICES - 1);
    const bounds = [start, ...inside, end];
    return bounds.slice(0, -1).map((from, index) => ({ start: from, end: bounds[index + 1]! }));
};

/** Cuts that split `start .. end` into `count` equal parts. */
export const evenCuts = (start: number, end: number, count: number): number[] => {
    const parts = Math.max(1, Math.min(MAX_SLICES, Math.round(count)));
    return Array.from({ length: parts - 1 }, (_, index) => start + ((end - start) * (index + 1)) / parts);
};

export interface OnsetOptions {
    /** 0..1: higher finds softer hits. */
    sensitivity?: number;
    /** Seconds two hits must be apart at least. */
    minGap?: number;
}

/** Length (seconds) of the frames the detector looks at. */
const FRAME_SECONDS = 0.005;

/**
 * Where the hits are in `start .. end` (seconds): the moments the level jumps, like the attack of a drum or a
 * plucked note. The signal is differentiated first, so the bright start of a hit counts more than a slow
 * swell, and a jump only counts when it stands out against the frames just before it. The start of the
 * region is never returned, it already is the start of the first slice.
 */
export const detectOnsets = (channels: readonly Float32Array[], sampleRate: number, start: number, end: number, options: OnsetOptions = {}): number[] => {
    const sensitivity = Math.min(1, Math.max(0, options.sensitivity ?? 0.5));
    const minGap = options.minGap ?? 0.06;
    const frame = Math.max(16, Math.round(FRAME_SECONDS * sampleRate));
    const first = Math.max(0, Math.floor(start * sampleRate));
    const last = Math.min(channels[0]?.length ?? 0, Math.ceil(end * sampleRate));
    const frames = Math.floor((last - first) / frame);
    if (frames < 3) {
        return [];
    }

    // Energy of the first difference (a gentle high-pass) per frame, in dB.
    const level = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        let energy = 0;
        const from = first + f * frame;
        for (const channel of channels) {
            let prior = channel[from - 1] ?? 0;
            for (let i = from; i < from + frame; i++) {
                const sample = channel[i]!;
                const diff = sample - prior;
                energy += diff * diff;
                prior = sample;
            }
        }
        level[f] = 10 * Math.log10(energy / (frame * channels.length) + 1e-10);
    }

    const peak = level.reduce((max, value) => Math.max(max, value), -Infinity);
    // Frames far below the loudest part are noise floor, not hits.
    const floor = peak - 30 - sensitivity * 25;
    // How many dB the level has to jump over the recent past to count as a hit.
    const jump = 12 - sensitivity * 9;
    const history = 4;

    const onsets: number[] = [];
    let lastOnset = -Infinity;
    for (let f = 1; f < frames; f++) {
        if (level[f]! < floor) {
            continue;
        }
        let recent = -Infinity;
        for (let back = 1; back <= history && f - back >= 0; back++) {
            recent = Math.max(recent, level[f - back]!);
        }
        const rise = level[f]! - Math.max(recent, floor - jump);
        // A hit is where the rise peaks: the next frame must not rise even more.
        const nextRise = f + 1 < frames ? level[f + 1]! - level[f]! : 0;
        if (rise >= jump && nextRise < jump) {
            const time = (first + f * frame) / sampleRate;
            if (time - lastOnset >= minGap && time - start >= minGap) {
                onsets.push(time);
                lastOnset = time;
            }
        }
    }
    return onsets.slice(0, MAX_SLICES - 1);
};
