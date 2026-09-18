/** Number of steps in one song section, and the default length of a new track. */
export const STEP_COUNT = 32;

/** A track's own length in steps: any multiple of this between the bounds below. Shorter tracks repeat inside a section, longer ones stretch across several. */
export const TRACK_LENGTH_STEP = 4;
export const MIN_TRACK_LENGTH = 4;
export const MAX_TRACK_LENGTH = 64;

/** The lengths offered in the UI. */
export const TRACK_LENGTHS: readonly number[] = [4, 8, 12, 16, 24, 32, 48, 64];

/** Snaps any number to a valid track length. */
export const normalizeTrackLength = (length: number): number => {
    const rounded = Math.round((Number.isFinite(length) ? length : STEP_COUNT) / TRACK_LENGTH_STEP) * TRACK_LENGTH_STEP;
    return Math.min(MAX_TRACK_LENGTH, Math.max(MIN_TRACK_LENGTH, rounded));
};

/** Note length of one sequencer step. */
export const STEP_SUBDIVISION = '16n';

export const DEFAULT_BPM = 136;

/** Ramp time (seconds) used when changing volume / pan so we do not get clicks. */
export const PARAM_RAMP_TIME = 0.01;
