import type { ToneAudioNode } from 'tone';
import { markRaw, reactive } from 'vue';
import { createId } from './audio';
import { MixBus, type BusSnapshot } from './mixBus';
import type { BaseTrack, TrackState } from './tracks/BaseTrack';
import { createTrack, type TrackOf, type TrackType } from './tracks/registry';

export interface ContainerState {
    id: string;
    name: string;
    bus: BusSnapshot;
    tracks: TrackState[];
}

/**
 * A group of tracks that loop together: what the track editor edits and what the song arranges.
 * Every track inside is a pattern with its own length; playing the container plays all of them at once.
 * All tracks are summed on the container's bus, which has its own effect rack and level before it goes to the master.
 */
export class TrackContainer {
    readonly id: string;
    readonly tracks: BaseTrack[] = [];

    /** The container channel: every track feeds it, it feeds the master. Not reactive, it owns Tone nodes. */
    readonly bus = markRaw(new MixBus());

    constructor(
        public name: string,
        id = createId(),
    ) {
        this.id = id;
    }

    /** Sends the container into a node (the master bus). */
    connectTo(destination: ToneAudioNode): void {
        this.bus.connectTo(destination);
    }

    addTrack<T extends TrackType>(type: T): TrackOf<T> {
        const track = createTrack(type);
        track.connectTo(this.bus.input);
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
        copy.connectTo(this.bus.input);
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

    /** Replaces this container's tracks and bus settings with copies of another container's. */
    async copyFrom(source: TrackContainer): Promise<void> {
        this.tracks.forEach((track) => track.dispose());
        this.tracks.length = 0;

        for (const track of source.tracks) {
            const copy: BaseTrack = createTrack(track.type);
            copy.connectTo(this.bus.input);
            await copy.copyFrom(track);
            this.tracks.push(copy);
        }
        this.bus.copyFrom(source.bus);
    }

    /* ---- history ---- */

    capture(): ContainerState {
        return { id: this.id, name: this.name, bus: this.bus.capture(), tracks: this.tracks.map((track) => track.capture()) };
    }

    /**
     * Takes a captured state back. Tracks that still exist keep their objects (and their decoded samples),
     * deleted ones come back with their old ids, and ones the state does not know are disposed.
     *
     * A track that comes back is restored through its reactive proxy (the same one the array hands the UI),
     * because a sample track finishes loading later and the UI must see it happen.
     */
    restore(state: ContainerState): void {
        this.name = state.name;
        this.bus.restore(state.bus);

        const next = state.tracks.map((trackState) => {
            const existing = this.tracks.find((track) => track.id === trackState.id && track.type === trackState.type);
            const track: BaseTrack = existing ?? (reactive(createTrack(trackState.type, trackState.id)) as unknown as BaseTrack);
            if (!existing) {
                track.connectTo(this.bus.input);
            }
            track.restore(trackState);
            return track;
        });
        for (const track of this.tracks) {
            if (!next.includes(track)) {
                track.dispose();
            }
        }
        this.tracks.splice(0, this.tracks.length, ...next);
    }

    dispose(): void {
        this.tracks.forEach((track) => track.dispose());
        this.tracks.length = 0;
        this.bus.dispose();
    }
}
