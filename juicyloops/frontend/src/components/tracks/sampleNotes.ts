import { SAMPLE_ROOT_NOTE, type SampleTick } from '@/juicyloops/ticks/SampleTick';
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';

/** What a sample step shows in the grid: the number of its slice, or its note when it is not the root. */
export const sampleTickLabel = (track: SampleTrack, tick: SampleTick): string => {
    if (track.isSliced) {
        return String(track.sliceIndexOf(tick.note) + 1);
    }
    return tick.note === SAMPLE_ROOT_NOTE ? '' : tick.note;
};
