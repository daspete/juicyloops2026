import { SAMPLE_ROOT_NOTE } from '@/juicyloops/notes';
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';

/** What a sample step shows in the grid for a note: the number of its slice, or the note when it is not the root. */
export const sampleNoteLabel = (track: SampleTrack, note: string): string => {
    if (track.isSliced) {
        return String(track.sliceIndexOf(note) + 1);
    }
    return note === SAMPLE_ROOT_NOTE ? '' : note;
};
