import { Player } from 'tone';
import { markRaw } from 'vue';
import { decodeBlob } from '../audio';
import { SampleTick } from '../ticks/SampleTick';
import { BaseTrack, type TrackSnapshot, type TrackState } from './BaseTrack';

export interface SampleTrackSnapshot extends TrackSnapshot {
    sampleName: string | null;
    sampleStartTime: number;
    sampleDuration: number;
    buffer: ArrayBuffer | null;
}

/** History keeps the sample by reference: the blob is never copied, only pointed at. */
export interface SampleTrackState extends TrackState {
    sampleBlob: Blob | null;
    sampleName: string | null;
    sampleStartTime: number;
    sampleDuration: number;
    isReversed: boolean;
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

    /** The last sample load that was started; `whenReady` waits for it. */
    private loading: Promise<void> = Promise.resolve();

    constructor(id?: string) {
        super(id);
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

    /** Resolves once the sample the track was last given is decoded and playable (right away when there is none). */
    whenReady(): Promise<void> {
        return this.loading;
    }

    /** Forgets the sample; the row shows its drop zone or record button again. */
    clearSample(): void {
        this.player.stop();
        this.sampleBlob = null;
        this.sampleName = null;
        this.hasSample = false;
        this.setSampleTimes(0, 0);
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

    capture(): SampleTrackState {
        return {
            ...super.capture(),
            sampleBlob: this.sampleBlob,
            sampleName: this.sampleName,
            sampleStartTime: this.sampleStartTime,
            sampleDuration: this.sampleDuration,
            isReversed: this.isReversed,
        };
    }

    restore(state: TrackState): void {
        super.restore(state);
        const sample = state as SampleTrackState;
        if (sample.sampleBlob !== this.sampleBlob) {
            if (sample.sampleBlob) {
                // Decoding is asynchronous; the slice is set once the audio is back.
                this.loading = this.loadSample(sample.sampleBlob, sample.sampleName)
                    .then(() => this.setSampleTimes(sample.sampleStartTime, sample.sampleDuration))
                    .catch((error) => console.warn('Could not decode the sample', sample.sampleName, error));
            } else {
                this.clearSample();
            }
        } else {
            this.sampleName = sample.sampleName;
            this.setSampleTimes(sample.sampleStartTime, sample.sampleDuration);
        }
        this.setReversed(sample.isReversed);
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
