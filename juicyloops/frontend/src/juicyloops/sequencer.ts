import { getDraw, getTransport } from 'tone';
import { STEP_COUNT, STEP_SUBDIVISION } from './constants';
import { Song } from './song';
import type { BaseTrack } from './tracks/BaseTrack';
import { createTrack, type TrackOf, type TrackType } from './tracks/registry';

/**
 * `loop` plays every track's pattern over and over (the track editor).
 * `song` walks through the arrangement section by section and only plays the tracks placed there.
 */
export type PlaybackMode = 'loop' | 'song';

/** `step` is the position inside the pattern, `section` the position inside the song (always 0 in loop mode). */
export type StepListener = (step: number, section: number) => void;

/** Owns the tracks and the song, and drives them from a repeating transport event. */
export class Sequencer {
    readonly tracks: BaseTrack[] = [];
    readonly song = new Song();

    mode: PlaybackMode = 'loop';

    private eventId: number | null = null;
    private readonly stepListeners = new Set<StepListener>();

    /** Schedules the step callback on the transport. Safe to call more than once. */
    start(): void {
        if (this.eventId !== null) {
            return;
        }

        this.eventId = getTransport().scheduleRepeat((time) => this.playStep(time), STEP_SUBDIVISION, 0);
    }

    setMode(mode: PlaybackMode): void {
        this.mode = mode;
    }

    /** Moves the play position to the start of a section (also while playing). */
    seekToSection(index: number): void {
        const transport = getTransport();
        transport.ticks = index * STEP_COUNT * this.ticksPerStep;
    }

    /**
     * Registers a callback that runs when a step becomes audible (not when it is scheduled).
     * Use it for UI updates. Returns a function that removes the listener again.
     */
    onStep(listener: StepListener): () => void {
        this.stepListeners.add(listener);
        return () => this.stepListeners.delete(listener);
    }

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
        this.song.removeTrack(id);
    }

    /** Creates a new track of the same type with the same pattern, settings and place in the song. */
    async duplicateTrack(id: string): Promise<BaseTrack | null> {
        const source = this.getTrack(id);
        if (!source) {
            return null;
        }

        const copy: BaseTrack = this.addTrack(source.type);
        await copy.copyFrom(source);
        this.song.copyTrack(source.id, copy.id);
        return copy;
    }

    private get ticksPerStep(): number {
        // A step is a sixteenth note and PPQ is the number of ticks per quarter note.
        return getTransport().PPQ / 4;
    }

    private playStep(time: number): void {
        /*
         * The transport runs freely; the pattern position and the section are derived from its tick count.
         * In song mode the section wraps around at the end of the arrangement, so the song loops.
         */
        const absoluteStep = Math.round(getTransport().getTicksAtTime(time) / this.ticksPerStep);
        const step = absoluteStep % STEP_COUNT;
        const section = this.mode === 'song' ? Math.floor(absoluteStep / STEP_COUNT) % this.song.length : 0;

        for (const track of this.tracks) {
            if (this.mode === 'loop' || this.song.plays(section, track.id)) {
                track.play(step, time);
            }
        }

        // The callback fires ahead of time (transport look-ahead), so UI updates are deferred until the step is heard.
        getDraw().schedule(() => this.stepListeners.forEach((listener) => listener(step, section)), time);
    }
}
