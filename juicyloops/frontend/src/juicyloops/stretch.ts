/**
 * Time stretching: making audio longer or shorter without changing its pitch.
 *
 * WSOLA (waveform similarity overlap-add): the output is built from short overlapping windows of the input.
 * Every window is taken from roughly where the stretch says it should come from, but nudged by a few
 * milliseconds to the spot whose waveform lines up best with what was written last, so the windows join
 * without the phasing and flutter a plain granular stretch has.
 *
 * Pitch shifting builds on it: stretch by the pitch ratio, then play the result that much faster (or slower).
 * The length comes back to where it was and only the pitch moved. That is what sample tracks do.
 */

/** Window length in seconds. Short enough to keep drum hits tight, long enough to hold a low note. */
const WINDOW_SECONDS = 0.04;

/** How far (seconds) a window may move from its nominal position to find the best fit. */
const TOLERANCE_SECONDS = 0.012;

/** Correlation is measured on every n-th sample; plenty for finding where two waveforms line up, and n times cheaper. */
const DECIMATION = 4;

/** Stretch factors this close to 1 leave the audio untouched. */
const IDENTITY_EPSILON = 1e-4;

/** A mono sum of the channels, only used to decide where windows go. */
const mixdown = (channels: readonly Float32Array[]): Float32Array => {
    if (channels.length === 1) {
        return channels[0]!;
    }
    const length = channels[0]?.length ?? 0;
    const mono = new Float32Array(length);
    for (const channel of channels) {
        for (let i = 0; i < length; i++) {
            mono[i]! += channel[i]!;
        }
    }
    return mono;
};

/** How alike two stretches of `signal` are (normalized cross-correlation), comparing every `DECIMATION`-th sample. */
const similarity = (signal: Float32Array, a: number, b: number, length: number): number => {
    let dot = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = 0; i < length; i += DECIMATION) {
        const x = signal[a + i] ?? 0;
        const y = signal[b + i] ?? 0;
        dot += x * y;
        energyA += x * x;
        energyB += y * y;
    }
    const norm = Math.sqrt(energyA * energyB);
    return norm > 1e-12 ? dot / norm : 0;
};

/**
 * Stretches audio by `factor` (2 = twice as long, 0.5 = half) keeping its pitch.
 * Takes and returns one array per channel; the input is never modified. A factor of 1 returns copies.
 */
export const timeStretch = (channels: readonly Float32Array[], sampleRate: number, factor: number): Float32Array<ArrayBuffer>[] => {
    const inputLength = channels[0]?.length ?? 0;
    if (!(factor > 0) || Math.abs(factor - 1) < IDENTITY_EPSILON || inputLength === 0) {
        return channels.map((channel) => channel.slice());
    }

    const windowLength = Math.max(64, Math.round(WINDOW_SECONDS * sampleRate) & ~1);
    const hop = windowLength / 2;
    const tolerance = Math.round(TOLERANCE_SECONDS * sampleRate);
    const outputLength = Math.max(1, Math.round(inputLength * factor));

    // Hann windows at half overlap add up to exactly one, so the output needs no normalizing.
    const window = new Float32Array(windowLength);
    for (let i = 0; i < windowLength; i++) {
        window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / windowLength);
    }

    const output = channels.map(() => new Float32Array(outputLength + windowLength));
    const mono = mixdown(channels);

    /** Where the last window was read from; the next one should continue from `previous + hop`. */
    let previous = 0;

    for (let written = 0, frame = 0; written < outputLength; written += hop, frame++) {
        const nominal = Math.round(written / factor);
        let source = nominal;

        if (frame > 0) {
            // The input that would naturally follow the last window; find the offset near `nominal` that matches it best.
            const natural = previous + hop;
            const low = Math.max(0, nominal - tolerance);
            const high = Math.min(inputLength - hop, nominal + tolerance);
            let best = -Infinity;
            // Coarse pass on a grid, then a fine pass around the winner.
            for (let candidate = low; candidate <= high; candidate += DECIMATION * 2) {
                const score = similarity(mono, natural, candidate, hop);
                if (score > best) {
                    best = score;
                    source = candidate;
                }
            }
            const coarse = source;
            for (let candidate = Math.max(low, coarse - DECIMATION * 2); candidate <= Math.min(high, coarse + DECIMATION * 2); candidate++) {
                const score = similarity(mono, natural, candidate, hop);
                if (score > best) {
                    best = score;
                    source = candidate;
                }
            }
        }

        channels.forEach((channel, c) => {
            const target = output[c]!;
            for (let i = 0; i < windowLength; i++) {
                target[written + i]! += (channel[source + i] ?? 0) * window[i]!;
            }
        });
        previous = source;
    }

    // The first half window only had one window over it: bring its fade-in back up.
    for (const target of output) {
        for (let i = 0; i < hop && i < outputLength; i++) {
            const gain = window[i]!;
            if (gain > 1e-3) {
                target[i]! /= gain;
            }
        }
    }

    return output.map((target) => target.slice(0, outputLength));
};

/** The ratio a playback rate needs for a shift of `semitones`. */
export const semitoneRatio = (semitones: number): number => 2 ** (semitones / 12);
