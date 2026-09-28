import type { ToneAudioNode } from 'tone';
import { markRaw, reactive, toRaw } from 'vue';
import { createId } from './audio';
import { voiceTail, type Sleeper } from './hibernate';
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
export class TrackContainer implements Sleeper {
    readonly id: string;
    readonly tracks: BaseTrack[] = [];

    /** The container channel: every track feeds it, it feeds the master. Not reactive, it owns Tone nodes. */
    readonly bus = markRaw(new MixBus('bus'));

    /**
     * False while the container sleeps: nothing is due for it, so its bus is out of the mix and its racks and synth
     * voices are freed (see `hibernate.ts`). The sequencer decides; editing works the same either way.
     */
    isAwake = true;

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
        this.adopt(track);
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
        this.adopt(copy);
        await copy.copyFrom(source);
        this.tracks.splice(this.tracks.indexOf(source) + 1, 0, copy);
        return copy;
    }

    /** A track without its reactive proxy (restored tracks are reactive), for what runs in the audio callback. */
    rawTrack(id: string): BaseTrack | undefined {
        const tracks = toRaw(this.tracks);
        for (let i = 0; i < tracks.length; i++) {
            const track = toRaw(tracks[i]!);
            if (track.id === id) {
                return track;
            }
        }
        return undefined;
    }

    /** Schedules every track for a step. Runs in the audio callback, so it goes through the raw objects, never a proxy. */
    play(step: number, time: number): void {
        const tracks = toRaw(this.tracks);
        for (let i = 0; i < tracks.length; i++) {
            toRaw(tracks[i]!).play(step, time);
        }
    }

    /** Whether a track here holds a live (MIDI) note; the sequencer keeps the container awake meanwhile. */
    hasLiveNotes(): boolean {
        const tracks = toRaw(this.tracks);
        for (let i = 0; i < tracks.length; i++) {
            if (toRaw(tracks[i]!).liveNoteCount > 0) {
                return true;
            }
        }
        return false;
    }

    /* ---- hibernation (see `hibernate.ts`); called on the raw object, from the step callback ---- */

    /** Takes the container out of the mix and frees its racks and synth voices. Only once nothing it played can still sound. */
    sleep(): void {
        if (!this.isAwake) {
            return;
        }
        this.isAwake = false;
        const tracks = toRaw(this.tracks);
        for (let i = 0; i < tracks.length; i++) {
            toRaw(tracks[i]!).sleep();
        }
        this.bus.sleep();
    }

    /** Builds everything `sleep` freed and goes back into the mix. A reverb needs a moment for its impulse response. */
    wake(): void {
        if (this.isAwake) {
            return;
        }
        this.isAwake = true;
        this.bus.wake();
        const tracks = toRaw(this.tracks);
        for (let i = 0; i < tracks.length; i++) {
            toRaw(tracks[i]!).wake();
        }
    }

    /**
     * Seconds the container can still be heard after its last step: the longest voice plus its track's effect tail,
     * plus the bus's effect tail. `stepSeconds` is the length of a step at the current tempo.
     */
    tail(stepSeconds: number): number {
        let longest = 0;
        const tracks = toRaw(this.tracks);
        for (let i = 0; i < tracks.length; i++) {
            const track = toRaw(tracks[i]!);
            longest = Math.max(longest, voiceTail(track, stepSeconds) + track.effects.tail());
        }
        return longest + this.bus.effects.tail();
    }

    /** Wires a new track into the bus; in a sleeping container it goes to sleep with the others. */
    private adopt(track: BaseTrack): void {
        track.connectTo(this.bus.input);
        if (!this.isAwake) {
            track.sleep();
        }
    }

    /** Replaces this container's tracks and bus settings with copies of another container's. */
    async copyFrom(source: TrackContainer): Promise<void> {
        this.tracks.forEach((track) => track.dispose());
        this.tracks.length = 0;

        for (const track of source.tracks) {
            const copy: BaseTrack = createTrack(track.type);
            this.adopt(copy);
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
                this.adopt(toRaw(track));
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
