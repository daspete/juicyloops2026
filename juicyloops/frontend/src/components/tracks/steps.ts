import { STEP_COUNT } from '@/juicyloops/constants';

/** Steps per beat, i.e. how many cells sit together in one visual group. */
export const BEAT_SIZE = 4;

export const BEATS_PER_BAR = 4;

/** Step indices grouped by beat: `[[0,1,2,3], [4,5,6,7], ...]`. The grid, the piano roll and the velocity lane all render from this. */
export const BEATS: readonly (readonly number[])[] = Array.from({ length: STEP_COUNT / BEAT_SIZE }, (_, beat) =>
    Array.from({ length: BEAT_SIZE }, (_, i) => beat * BEAT_SIZE + i),
);

/** `bar.beat.step`, all 1-based, the way a DAW shows the play position. */
export const positionLabel = (step: number): string => {
    const stepsPerBar = BEAT_SIZE * BEATS_PER_BAR;
    const bar = Math.floor(step / stepsPerBar) + 1;
    const beat = Math.floor((step % stepsPerBar) / BEAT_SIZE) + 1;
    const sub = (step % BEAT_SIZE) + 1;
    return `${bar}.${beat}.${sub}`;
};

/** 1..4 label for a beat index (0-based) inside its bar. */
export const beatNumber = (beat: number): number => (beat % BEATS_PER_BAR) + 1;
