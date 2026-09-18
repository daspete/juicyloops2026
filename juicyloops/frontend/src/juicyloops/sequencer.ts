import { getDraw, getTransport } from 'tone';
import { STEP_COUNT, STEP_SUBDIVISION } from './constants';
import { Song } from './song';
import { TrackContainer } from './trackContainer';

/**
 * `loop` plays the current container over and over (the track editor).
 * `song` walks through the arrangement section by section and plays the containers placed there.
 */
export type PlaybackMode = 'loop' | 'song';

/** `step` is the position inside the pattern, `section` the position inside the song (always 0 in loop mode). */
export type StepListener = (step: number, section: number) => void;

/** Owns the containers and the song, and drives them from a repeating transport event. */
export class Sequencer {
    readonly containers: TrackContainer[] = [];
    readonly song = new Song();

    mode: PlaybackMode = 'loop';

    /** The container the track editor shows and loop mode plays. */
    currentContainer: TrackContainer;

    private eventId: number | null = null;
    private readonly stepListeners = new Set<StepListener>();

    constructor() {
        this.currentContainer = this.addContainer();
    }

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
        getTransport().ticks = index * STEP_COUNT * this.ticksPerStep;
    }

    /**
     * Registers a callback that runs when a step becomes audible (not when it is scheduled).
     * Use it for UI updates. Returns a function that removes the listener again.
     */
    onStep(listener: StepListener): () => void {
        this.stepListeners.add(listener);
        return () => this.stepListeners.delete(listener);
    }

    addContainer(name = `Container ${this.containers.length + 1}`): TrackContainer {
        const container = new TrackContainer(name);
        this.containers.push(container);
        return container;
    }

    getContainer(id: string): TrackContainer | undefined {
        return this.containers.find((container) => container.id === id);
    }

    setCurrentContainer(id: string): void {
        const container = this.getContainer(id);
        if (container) {
            this.currentContainer = container;
        }
    }

    /** Removes a container unless it is the last one. The current container falls back to a neighbour. */
    removeContainer(id: string): void {
        const index = this.containers.findIndex((container) => container.id === id);
        if (index === -1 || this.containers.length === 1) {
            return;
        }

        this.containers[index]!.dispose();
        this.containers.splice(index, 1);
        this.song.removeContainer(id);

        if (this.currentContainer.id === id) {
            this.currentContainer = this.containers[Math.min(index, this.containers.length - 1)]!;
        }
    }

    /** Creates a container with copies of all tracks, right after the original. */
    async duplicateContainer(id: string): Promise<TrackContainer | null> {
        const source = this.getContainer(id);
        if (!source) {
            return null;
        }

        const copy = new TrackContainer(`${source.name} copy`);
        await copy.copyFrom(source);
        this.containers.splice(this.containers.indexOf(source) + 1, 0, copy);
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

        if (this.mode === 'loop') {
            this.currentContainer.play(step, time);
        } else {
            for (const container of this.containers) {
                if (this.song.plays(section, container.id)) {
                    container.play(step, time);
                }
            }
        }

        // The callback fires ahead of time (transport look-ahead), so UI updates are deferred until the step is heard.
        getDraw().schedule(() => this.stepListeners.forEach((listener) => listener(step, section)), time);
    }
}
