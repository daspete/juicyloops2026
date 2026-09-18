import { STEP_COUNT } from '@/juicyloops/constants';

/** Steps per beat, i.e. how many cells sit together in one visual group. */
export const BEAT_SIZE = 4;

export const BEATS_PER_BAR = 4;

/** Step indices grouped by beat: `[[0,1,2,3], [4,5,6,7], ...]` for a pattern of `length` steps. */
export const beatsOf = (length: number): readonly (readonly number[])[] =>
    Array.from({ length: Math.ceil(length / BEAT_SIZE) }, (_, beat) =>
        Array.from({ length: Math.min(BEAT_SIZE, length - beat * BEAT_SIZE) }, (_, i) => beat * BEAT_SIZE + i),
    );

/** The beats of one song section, which is what the ruler shows. Rows render from `beatsOf(track.length)` instead. */
export const BEATS = beatsOf(STEP_COUNT);

export const STEPS_PER_BAR = BEAT_SIZE * BEATS_PER_BAR;

/** How many bars one pass of the pattern (one song section) lasts. */
export const BARS_PER_SECTION = STEP_COUNT / STEPS_PER_BAR;

/** `bar.beat.step`, all 1-based, the way a DAW shows the play position, for an absolute step. */
export const positionLabel = (step: number): string => {
    const bar = Math.floor(step / STEPS_PER_BAR) + 1;
    const beat = Math.floor((step % STEPS_PER_BAR) / BEAT_SIZE) + 1;
    const sub = (step % BEAT_SIZE) + 1;
    return `${bar}.${beat}.${sub}`;
};

/** 1..4 label for a beat index (0-based) inside its bar. */
export const beatNumber = (beat: number): number => (beat % BEATS_PER_BAR) + 1;
