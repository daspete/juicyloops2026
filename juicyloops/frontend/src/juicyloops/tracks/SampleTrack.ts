import { Player } from 'tone';
import { markRaw } from 'vue';
import { decodeBlob } from '../audio';
import { SampleTick } from '../ticks/SampleTick';
import { BaseTrack, type TrackSnapshot } from './BaseTrack';

export interface SampleTrackSnapshot extends TrackSnapshot {
    sampleName: string | null;
    sampleStartTime: number;
    sampleDuration: number;
    buffer: ArrayBuffer | null;
}

/**
 * A track that plays a slice of an audio buffer on every active tick.
 * Where the buffer comes from (a file, the microphone, ...) is up to the subclass.
 */
export abstract class SampleTrack extends BaseTrack<SampleTick> {
    protected readonly player = markRaw(new Player());

    /** The raw audio the player was loaded from. Kept for the waveform view, serialization and duplication. */
    sampleBlob: Blob | null = null;
    sampleName: string | null = null;
    hasSample = false;

    /** Start offset (seconds) and length (seconds) of the slice that is played. */
    sampleStartTime = 0;
    sampleDuration = 0;

    isReversed = false;

    constructor() {
        super();
        this.connectSource(this.player);
    }

    protected createTick(): SampleTick {
        return new SampleTick();
    }

    /** Decodes `blob`, loads it into the player and resets the slice to the whole sample. */
    async loadSample(blob: Blob, name: string | null = this.sampleName): Promise<void> {
        const buffer = await decodeBlob(blob);

        this.player.buffer.set(buffer);
        this.sampleBlob = blob;
        this.sampleName = name;
        this.setSampleTimes(0, buffer.duration);
        this.hasSample = true;
    }

    setSampleTimes(start: number, duration: number): void {
        this.sampleStartTime = start;
        this.sampleDuration = duration;
    }

    setReversed(reversed: boolean): void {
        this.isReversed = reversed;
        this.player.reverse = reversed;
    }

    toggleReverse(): void {
        this.setReversed(!this.isReversed);
    }

    protected trigger(step: number, time: number): void {
        if (!this.player.loaded || !this.activeTick(step)) {
            return;
        }

        this.player.start(time, this.sampleStartTime, this.sampleDuration);
    }

    async copyFrom(source: this): Promise<void> {
        await super.copyFrom(source);

        if (source.sampleBlob) {
            await this.loadSample(source.sampleBlob, source.sampleName);
        }

        this.setSampleTimes(source.sampleStartTime, source.sampleDuration);
        this.setReversed(source.isReversed);
    }

    dispose(): void {
        this.player.dispose();
        super.dispose();
    }

    async serialize(): Promise<SampleTrackSnapshot> {
        return {
            ...(await super.serialize()),
            sampleName: this.sampleName,
            sampleStartTime: this.sampleStartTime,
            sampleDuration: this.sampleDuration,
            buffer: (await this.sampleBlob?.arrayBuffer()) ?? null,
        };
    }
}
