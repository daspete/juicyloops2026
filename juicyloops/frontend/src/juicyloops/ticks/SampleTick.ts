import { transpose } from '../notes';
import { BaseTick, type TickSnapshot } from './BaseTick';

/** The key a sample plays at its own pitch, and the key of its first slice. */
export const SAMPLE_ROOT_NOTE = 'C5';

export interface SampleTickSnapshot extends TickSnapshot {
    note: string;
}

/**
 * A step of a track that plays back an audio buffer (sampler and microphone tracks).
 *
 * The note says what the step plays: a sample that is not sliced is played higher or lower by the distance
 * from `SAMPLE_ROOT_NOTE`; a sliced one plays the slice that sits on that key (the root is the first slice,
 * every semitone up is the next).
 */
export class SampleTick extends BaseTick {
    note = SAMPLE_ROOT_NOTE;

    /** Snapshots from before notes kept the offset from the root in semitones, as `pitch`. */
    restore(snapshot: TickSnapshot): void {
        const { pitch, ...rest } = snapshot as Partial<SampleTickSnapshot> & TickSnapshot & { pitch?: number };
        Object.assign(this, rest);
        if (rest.note === undefined) {
            this.note = transpose(SAMPLE_ROOT_NOTE, pitch ?? 0);
        }
    }

    serialize(): SampleTickSnapshot {
        return {
            ...super.serialize(),
            note: this.note,
        };
    }
}
