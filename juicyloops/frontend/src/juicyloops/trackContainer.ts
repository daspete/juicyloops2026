import { createId } from './audio';
import type { BaseTrack } from './tracks/BaseTrack';
import { createTrack, type TrackOf, type TrackType } from './tracks/registry';

/**
 * A group of tracks that loop together: what the track editor edits and what the song arranges.
 * Every track inside is a pattern of `STEP_COUNT` steps; playing the container plays all of them at once.
 */
export class TrackContainer {
    readonly id = createId();
    readonly tracks: BaseTrack[] = [];

    constructor(public name: string) {}

    addTrack<T extends TrackType>(type: T): TrackOf<T> {
        const track = createTrack(type);
        this.tracks.push(track);
        return track;
    }

    getTrack(id: string): BaseTrack | undefined {
        return this.tracks.find((track) => track.id === id);
    }

    removeTrack(id: string): void {
        const index = this.tracks.findIndex((track) => track.id === id);
        if (index === -1) {
            return;
        }

        this.tracks[index]!.dispose();
        this.tracks.splice(index, 1);
    }

    /** Creates a new track of the same type with the same pattern and settings, right after the original. */
    async duplicateTrack(id: string): Promise<BaseTrack | null> {
        const source = this.getTrack(id);
        if (!source) {
            return null;
        }

        const copy: BaseTrack = createTrack(source.type);
        await copy.copyFrom(source);
        this.tracks.splice(this.tracks.indexOf(source) + 1, 0, copy);
        return copy;
    }

    /** Schedules every track for a step. */
    play(step: number, time: number): void {
        for (const track of this.tracks) {
            track.play(step, time);
        }
    }

    /** Replaces this container's tracks with copies of another container's tracks. */
    async copyFrom(source: TrackContainer): Promise<void> {
        this.tracks.forEach((track) => track.dispose());
        this.tracks.length = 0;

        for (const track of source.tracks) {
            const copy: BaseTrack = createTrack(track.type);
            await copy.copyFrom(track);
            this.tracks.push(copy);
        }
    }

    dispose(): void {
        this.tracks.forEach((track) => track.dispose());
        this.tracks.length = 0;
    }
}
