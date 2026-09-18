import { getDraw, getTransport } from 'tone';
import { markRaw, reactive, toRaw } from 'vue';
import { toValue, valueAt, type Automatable, type AutomationTarget } from './automation';
import { STEP_SUBDIVISION } from './constants';
import { MixBus, type BusSnapshot } from './mixBus';
import { Song, type SongState } from './song';
import { TrackContainer, type ContainerState } from './trackContainer';

/** The whole session as history keeps it. Tempo is added by the UI, which owns it. */
export interface SessionState {
    containers: ContainerState[];
    currentContainerId: string;
    song: SongState;
    master: BusSnapshot;
}

/**
 * `loop` plays the current container over and over (the track editor).
 * `song` walks through the arrangement section by section and plays the containers placed there.
 */
export type PlaybackMode = 'loop' | 'song';

/**
 * `step` is the play position: inside the song in song mode (it wraps at the song's end),
 * a running count in loop mode that tracks wrap around their own length.
 */
export type StepListener = (step: number) => void;

/**
 * Owns the containers, the song and the master bus, and drives playback from a repeating transport event.
 *
 * The containers and the song are reactive, so the UI sees every change made here (adding, removing,
 * restoring from history). Playback goes through the raw objects: the audio callback must not pay for proxies.
 */
export class Sequencer {
    readonly containers: TrackContainer[] = reactive([]);
    readonly song: Song = reactive(new Song()) as Song;

    /** The master channel: every container feeds it, it feeds the speakers. */
    readonly master = markRaw(new MixBus());

    mode: PlaybackMode = 'loop';

    /** The container the track editor shows and loop mode plays. */
    currentContainer: TrackContainer;

    private eventId: number | null = null;
    private readonly stepListeners = new Set<StepListener>();

    constructor() {
        this.master.toDestination();
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

    /** Moves the play position to a step (also while playing). */
    seekToStep(step: number): void {
        getTransport().ticks = Math.max(0, step) * this.ticksPerStep;
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
        container.connectTo(this.master.input);
        this.containers.push(container);
        return container;
    }

    getContainer(id: string): TrackContainer | undefined {
        return this.containers.find((container) => container.id === id);
    }

    setCurrentContainer(id: string): void {
        const container = this.rawContainer(id);
        if (container) {
            this.currentContainer = container;
        }
    }

    /** Puts every automated parameter back to its stored value, e.g. when playback stops. */
    settleAutomation(): void {
        for (const container of toRaw(this.containers)) {
            for (const track of container.tracks) {
                track.settleAll();
            }
        }
        for (const lane of this.song.automation) {
            this.resolveTarget(lane.target)?.settle(lane.param);
        }
    }

    /* ---- history ---- */

    capture(): SessionState {
        return {
            containers: this.containers.map((container) => container.capture()),
            currentContainerId: this.currentContainer.id,
            song: this.song.capture(),
            master: this.master.capture(),
        };
    }

    /** Takes a captured state back. Containers that still exist keep their objects, deleted ones return with their ids. */
    restore(state: SessionState): void {
        const next = state.containers.map((containerState) => {
            const existing = this.getContainer(containerState.id);
            const container = existing ?? new TrackContainer(containerState.name, containerState.id);
            if (!existing) {
                container.connectTo(this.master.input);
            }
            container.restore(containerState);
            return container;
        });
        for (const container of this.containers) {
            if (!next.includes(container)) {
                toRaw(container).dispose();
            }
        }
        this.containers.splice(0, this.containers.length, ...next);
        this.song.restore(state.song);
        this.master.restore(state.master);
        this.setCurrentContainer(state.currentContainerId);
        if (!this.containers.some((container) => container.id === this.currentContainer.id)) {
            this.currentContainer = toRaw(this.containers[0]!);
        }
    }

    /** Removes a container unless it is the last one. The current container falls back to a neighbour. */
    removeContainer(id: string): void {
        const index = this.containers.findIndex((container) => container.id === id);
        if (index === -1 || this.containers.length === 1) {
            return;
        }

        toRaw(this.containers[index]!).dispose();
        this.containers.splice(index, 1);
        this.song.removeContainer(id);

        if (this.currentContainer.id === id) {
            this.currentContainer = toRaw(this.containers[Math.min(index, this.containers.length - 1)]!);
        }
    }

    /** What a song automation lane drives (the raw object, this runs during playback), or undefined when it was deleted. */
    resolveTarget(target: AutomationTarget): (Automatable & { settle(key: string): void }) | undefined {
        if (target.kind === 'master') {
            return this.master;
        }
        const container = this.rawContainer(target.containerId);
        return target.kind === 'container' ? container?.bus : container?.getTrack(target.trackId);
    }

    /** The container without its reactive proxy, for everything that runs in the audio callback. */
    private rawContainer(id: string): TrackContainer | undefined {
        return toRaw(this.containers).find((container) => container.id === id);
    }

    /** Creates a container with copies of all tracks, right after the original. */
    async duplicateContainer(id: string): Promise<TrackContainer | null> {
        const source = this.getContainer(id);
        if (!source) {
            return null;
        }

        const copy = new TrackContainer(`${source.name} copy`);
        copy.connectTo(this.master.input);
        await copy.copyFrom(source);
        this.containers.splice(this.containers.indexOf(source) + 1, 0, copy);
        return copy;
    }

    private applySongAutomation(song: Song, step: number, time: number): void {
        for (const lane of song.automation) {
            const target = this.resolveTarget(lane.target);
            const param = target?.parameters.find((candidate) => candidate.key === lane.param);
            const position = valueAt(lane.points, step);
            if (target && param && position !== null) {
                target.setParameter(lane.param, toValue(param, position), time);
            }
        }
    }

    private get ticksPerStep(): number {
        // A step is a sixteenth note and PPQ is the number of ticks per quarter note.
        return getTransport().PPQ / 4;
    }

    private playStep(time: number): void {
        /*
         * The transport runs freely; the play position is derived from its tick count.
         * In loop mode tracks wrap it around their own length. In song mode it wraps at the
         * end of the arrangement, so the song loops, and every clip plays its container from
         * the clip's own start.
         */
        const absoluteStep = Math.round(getTransport().getTicksAtTime(time) / this.ticksPerStep);
        const song = toRaw(this.song);
        const songLength = song.length;
        const step = this.mode === 'song' ? (songLength ? absoluteStep % songLength : 0) : absoluteStep;

        if (this.mode === 'loop') {
            this.currentContainer.play(step, time);
        } else {
            for (const [containerId, patternStep] of song.playingAt(step)) {
                this.rawContainer(containerId)?.play(patternStep, time);
            }
            // Song lanes come last, so they win over a track's own step lanes for the same parameter.
            this.applySongAutomation(song, step, time);
        }

        // The callback fires ahead of time (transport look-ahead), so UI updates are deferred until the step is heard.
        getDraw().schedule(() => this.stepListeners.forEach((listener) => listener(step)), time);
    }
}
