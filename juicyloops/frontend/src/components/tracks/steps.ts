import { STEP_COUNT } from '@/juicyloops/constants';

/** Steps per beat, i.e. how many cells sit together in one visual group. */
export const BEAT_SIZE = 4;

export const BEATS_PER_BAR = 4;

/** Step indices grouped by beat: `[[0,1,2,3], [4,5,6,7], ...]`. The grid, the piano roll and the velocity lane all render from this. */
export const BEATS: readonly (readonly number[])[] = Array.from({ length: STEP_COUNT / BEAT_SIZE }, (_, beat) =>
    Array.from({ length: BEAT_SIZE }, (_, i) => beat * BEAT_SIZE + i),
);

export const STEPS_PER_BAR = BEAT_SIZE * BEATS_PER_BAR;

/** How many bars one pass of the pattern (one song section) lasts. */
export const BARS_PER_SECTION = STEP_COUNT / STEPS_PER_BAR;

/** `bar.beat.step`, all 1-based, the way a DAW shows the play position. `section` shifts the bar count along the song. */
export const positionLabel = (step: number, section = 0): string => {
    const stepsPerBar = STEPS_PER_BAR;
    const bar = section * BARS_PER_SECTION + Math.floor(step / stepsPerBar) + 1;
    const beat = Math.floor((step % stepsPerBar) / BEAT_SIZE) + 1;
    const sub = (step % BEAT_SIZE) + 1;
    return `${bar}.${beat}.${sub}`;
};

/** 1..4 label for a beat index (0-based) inside its bar. */
export const beatNumber = (beat: number): number => (beat % BEATS_PER_BAR) + 1;
