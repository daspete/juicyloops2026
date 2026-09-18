import { BaseTick, type TickSnapshot } from './BaseTick';

export interface SampleTickSnapshot extends TickSnapshot {
    pitch: number;
}

/** A step of a track that plays back an audio buffer (sampler and microphone tracks). */
export class SampleTick extends BaseTick {
    pitch = 0;

    serialize(): SampleTickSnapshot {
        return {
            ...super.serialize(),
            pitch: this.pitch,
        };
    }
}
