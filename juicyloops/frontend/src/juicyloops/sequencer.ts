import { debug, getDraw, getTransport, type DrawInstance, type TransportInstance } from 'tone';
import { markRaw, reactive, toRaw } from 'vue';
import { firstPointAfter, toValue, valueAt, type Automatable, type AutomationTarget } from './automation';
import { STEP_SUBDIVISION } from './constants';
import { Hibernation, markDue, upcomingSegments, WAKE_WINDOW_STEPS } from './hibernate';
import { cloneMappings, type MidiMapping } from './midi/mappings';
import { MixBus, type BusSnapshot } from './mixBus';
import { RETURN_COUNT, sendIndexOf } from './sends';
import { parseEffectParamKey } from './effects/effects';
import { Song, songStepAt, type SongState } from './song';
import { TrackContainer, type ContainerState } from './trackContainer';

/** The whole session as history keeps it. Tempo is added by the UI, which owns it. */
export interface SessionState {
    containers: ContainerState[];
    currentContainerId: string;
    song: SongState;
    master: BusSnapshot;
    /** MIDI learn: which controller turns which knob. Missing in states from before MIDI. */
    midiMappings?: MidiMapping[];
    /** The return buses A and B. Missing in states from before the mixer rack: they come back with their defaults. */
    returns?: BusSnapshot[];
}

/** A fresh return: A holds a hall reverb, B an eighth-note echo, both fully wet (a return carries only the effect). */
const createReturn = (index: number): MixBus => {
    const bus = markRaw(new MixBus('return'));
    // Asleep from the start: no reverb is built until something sends to it (see `updateReturns`).
    bus.sleep();
    configureReturn(bus, index);
    return bus;
};

const configureReturn = (bus: MixBus, index: number): void => {
    bus.effects.clear();
    if (index === 0) {
        bus.effects.add('reverb', 0, { wet: 1, decay: 2.5, preDelay: 0.02 });
    } else {
        bus.effects.add('delay', 0, { wet: 1, delayTime: 0.25 });
    }
};

/** The state a return has in a session from before returns existed. */
const defaultReturnState = (index: number): BusSnapshot => {
    const bus = new MixBus('return');
    bus.sleep();
    configureReturn(bus, index);
    const state = bus.capture();
    bus.dispose();
    return state;
};

/** Seconds a return keeps sounding after its last send went quiet, before it sleeps (plus its effect tail). */
const RETURN_LINGER = 1;

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
 * Runs inside the step callback, ahead of time like the step itself, before anything is scheduled for the step: `step`
 * is the play position (as step listeners get it), `time` the audio-context time the step will be heard at. The
 * recorder uses it for the metronome and for clearing what a replace take passes. Only the live engine's sequencer has
 * one; offline renders never do.
 */
export type StepHook = (step: number, time: number) => void;

/**
 * Owns the containers, the song and the master bus, and drives playback from a repeating transport event.
 *
 * The containers and the song are reactive, so the UI sees every change made here (adding, removing,
 * restoring from history). Playback goes through the raw objects: the audio callback must not pay for proxies.
 */
export class Sequencer {
    readonly containers: TrackContainer[] = reactive([]);
    readonly song: Song = reactive(new Song()) as Song;

    /** MIDI learn mappings of the session (see `midi/mappings.ts`). Replaced as a whole on every change. */
    midiMappings: MidiMapping[] = reactive([]);

    /** The master channel: every container feeds it, it feeds the speakers. */
    readonly master = markRaw(new MixBus('master'));

    /** The return buses A and B: the sends of every channel feed them, they feed the master. */
    readonly returns: readonly MixBus[] = Array.from({ length: RETURN_COUNT }, (_, index) => createReturn(index));

    /** Return inputs, what every send points at. */
    private readonly sendTargets = this.returns.map((bus) => bus.input);

    /** When each return was last fed (performance.now), for putting idle returns to sleep. */
    private readonly returnFedAt: number[] = this.returns.map(() => 0);
    private readonly returnAsleep: boolean[] = this.returns.map(() => true);

    /**
     * The transport and draw loop of the context the sequencer was created in. Kept as references, so a sequencer
     * built inside an offline context (see `render.ts`) keeps driving that context after the global one is switched back.
     */
    private readonly transport: TransportInstance = getTransport();
    private readonly draw: DrawInstance = getDraw();

    mode: PlaybackMode = 'loop';

    /**
     * A stretch of the song that repeats in song mode, the loop region of a DAW's timeline. Playback reaching its
     * end jumps back to its start. Null plays the whole song and wraps at its end. Not part of the session.
     */
    loop: { start: number; end: number } | null = null;

    /** The container the track editor shows and loop mode plays. */
    currentContainer: TrackContainer;

    private eventId: number | null = null;
    private stepHook: StepHook | null = null;
    private readonly stepListeners = new Set<StepListener>();
    /** Reused by every song-mode step for the containers playing there, so the step callback does not allocate a map each time. */
    private readonly playing = new Map<string, number>();

    /**
     * Puts containers with nothing to play to sleep and wakes them before they are heard (see `hibernate.ts`).
     * Null in an offline context: a render keeps every container awake from start to end.
     */
    private readonly hibernation: Hibernation | null = this.transport.context.isOffline ? null : new Hibernation();
    /** Reused by every step: the containers due now or soon, and the song stretches the look-ahead covers. */
    private readonly due = new Set<string>();
    private readonly window: number[] = [0, 0, 0, 0];
    private readonly stepSeconds = (): number => 60 / this.transport.bpm.value / 4;
    /** Containers a track was played live in (MIDI); due while one of their tracks holds a note. */
    private readonly live = new Set<string>();

    constructor() {
        this.master.toDestination();
        for (const bus of this.returns) {
            bus.connectTo(this.master.input);
        }
        this.currentContainer = this.addContainer();
        this.updateReturns();
    }

    /** Schedules the step callback on the transport. Safe to call more than once. */
    start(): void {
        if (this.eventId !== null) {
            return;
        }

        this.eventId = this.transport.scheduleRepeat((time) => this.playStep(time), STEP_SUBDIVISION, 0);
    }

    setMode(mode: PlaybackMode): void {
        this.mode = mode;
        if (mode === 'loop') {
            this.hibernation?.wake(this.currentContainer);
        }
    }

    setLoop(loop: { start: number; end: number } | null): void {
        this.loop = loop && loop.end > loop.start ? { ...loop } : null;
    }

    /** Moves the play position to a step (also while playing). */
    seekToStep(step: number): void {
        this.transport.ticks = Math.max(0, step) * this.ticksPerStep;
        // Wake what plays at the new position right away, so its effects are ready by the time the step is heard.
        if (this.hibernation && this.mode === 'song') {
            const song = toRaw(this.song);
            const songLength = song.length;
            this.markDue(this.songStep(Math.max(0, step), songLength), song, songLength);
            for (const id of this.due) {
                const container = this.rawContainer(id);
                if (container) {
                    this.hibernation.wake(container);
                }
            }
        }
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
        container.setSendTargets(this.sendTargets);
        this.containers.push(container);
        return container;
    }

    getContainer(id: string): TrackContainer | undefined {
        return this.containers.find((container) => container.id === id);
    }

    /** In loop mode the new container is woken right away; the old one sleeps once its tail has rung out. */
    setCurrentContainer(id: string): void {
        const container = this.rawContainer(id);
        if (container) {
            this.currentContainer = container;
            if (this.mode === 'loop') {
                this.hibernation?.wake(container);
            }
        }
    }

    /**
     * Wakes the container of a track played live (MIDI) right away, so a note on a sleeping container sounds, and
     * keeps it awake while any of its tracks holds a live note. Afterwards it sleeps as usual, once its tail has rung out.
     */
    wakeForLive(containerId: string): void {
        const container = this.rawContainer(containerId);
        if (!container || !this.hibernation) {
            return;
        }
        this.live.add(containerId);
        this.hibernation.wake(container);
    }

    /** Sets (or with null removes) the hook that runs in the step callback before the step is scheduled. */
    setStepHook(hook: StepHook | null): void {
        this.stepHook = hook;
    }

    /** Replaces the MIDI mappings (a learned or removed mapping). */
    setMidiMappings(mappings: readonly MidiMapping[]): void {
        this.midiMappings.splice(0, this.midiMappings.length, ...cloneMappings(mappings));
    }

    /** Resolves once every sample is decoded and every effect can sound; what an offline render waits for. */
    async whenReady(): Promise<void> {
        const containers = toRaw(this.containers).map((container) => toRaw(container));
        const tracks = containers.flatMap((container) => container.tracks.map((track) => toRaw(track)));
        await Promise.all([
            ...tracks.map((track) => track.whenReady()),
            ...tracks.map((track) => track.effects.whenReady()),
            ...containers.map((container) => container.bus.effects.whenReady()),
            ...this.returns.map((bus) => bus.effects.whenReady()),
            this.master.effects.whenReady(),
        ]);
    }

    /** Takes the step callback off the transport and frees every audio node. For sequencers that only lived for a render. */
    dispose(): void {
        if (this.eventId !== null) {
            this.transport.clear(this.eventId);
            this.eventId = null;
        }
        for (const container of toRaw(this.containers)) {
            toRaw(container).dispose();
        }
        this.containers.length = 0;
        for (const bus of this.returns) {
            bus.dispose();
        }
        this.master.dispose();
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
            midiMappings: cloneMappings(this.midiMappings),
            returns: this.returns.map((bus) => bus.capture()),
        };
    }

    /**
     * Takes a captured state back. Containers that still exist keep their objects, deleted ones return with their ids.
     * New containers are restored through their reactive proxy, so the tracks inside are too (see `TrackContainer.restore`).
     */
    restore(state: SessionState): void {
        const next = state.containers.map((containerState) => {
            const existing = this.getContainer(containerState.id);
            const container = existing ?? (reactive(new TrackContainer(containerState.name, containerState.id)) as TrackContainer);
            if (!existing) {
                container.connectTo(this.master.input);
                container.setSendTargets(this.sendTargets);
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
        this.returns.forEach((bus, index) => bus.restore(state.returns?.[index] ?? defaultReturnState(index)));
        this.setMidiMappings(state.midiMappings ?? []);
        this.recoverLegacySlots();
        this.setCurrentContainer(state.currentContainerId);
        if (!this.containers.some((container) => container.id === this.currentContainer.id)) {
            this.setCurrentContainer(this.containers[0]!.id);
        }
        this.updateSolo();
        this.updateReturns();
    }

    /**
     * Racks converted from before effect slots dropped their idle effects; the ones a song lane or a MIDI mapping still
     * drives come back (a track's own lanes are handled by the track).
     */
    private recoverLegacySlots(): void {
        const drives = [...this.song.automation, ...this.midiMappings];
        for (const { target, param } of drives) {
            if (parseEffectParamKey(param)) {
                const owner = this.resolveTarget(target);
                (owner as { effects?: { ensureLegacySlots(keys: string[]): void } } | undefined)?.effects?.ensureLegacySlots([param]);
            }
        }
    }

    /* ---- mute, solo and returns ---- */

    /**
     * Applies the session's solo state. Solo is session-wide: while any track or container channel is soloed, every
     * track that is not soloed (and whose container is not) stays silent, and so does every container channel with
     * nothing soloed inside. Returns are solo-safe: they only answer to each other's solo, so a soloed track keeps its
     * reverb. Reads mute and solo through the reactive containers, so a `watchEffect` can call it.
     */
    updateSolo(): void {
        const containers = this.containers;
        let anySolo = false;
        for (const container of containers) {
            anySolo ||= container.bus.isSolo || container.tracks.some((track) => track.isSolo);
        }
        for (const container of containers) {
            const busSolo = container.bus.isSolo;
            const inside = container.tracks.some((track) => track.isSolo);
            container.bus.setSilenced(anySolo && !busSolo && !inside);
            for (const track of container.tracks) {
                toRaw(track).isSilenced = anySolo && !track.isSolo && !busSolo;
            }
        }
        const returnSolo = this.returns.some((bus) => bus.isSolo);
        for (const bus of this.returns) {
            bus.setSilenced(returnSolo && !bus.isSolo);
        }
    }

    /** Whether anything sends to a return: a send turned up, or a lane or mapping that can turn one up. */
    private isReturnFed(index: number): boolean {
        const key = `send.${index}`;
        for (const container of toRaw(this.containers)) {
            const raw = toRaw(container);
            if (raw.bus.sends?.feeds(index)) {
                return true;
            }
            for (const track of raw.tracks) {
                const rawTrack = toRaw(track);
                if (rawTrack.sends.feeds(index) || rawTrack.automation.lanes.some((lane) => lane.param === key)) {
                    return true;
                }
            }
        }
        const song = toRaw(this.song);
        return song.automation.some((lane) => lane.param === key) || this.midiMappings.some((mapping) => sendIndexOf(mapping.param) === index);
    }

    /**
     * Wakes a return as soon as something sends to it and puts it to sleep once nothing has for a while (its effect
     * tail and a second), so a session that uses no sends pays nothing for the returns' reverb and delay. An offline
     * render keeps them awake.
     */
    updateReturns(): void {
        const now = performance.now();
        this.returns.forEach((bus, index) => {
            if (this.isReturnFed(index) || !this.hibernation) {
                this.returnFedAt[index] = now;
                if (this.returnAsleep[index]) {
                    this.returnAsleep[index] = false;
                    bus.wake();
                }
            } else if (!this.returnAsleep[index] && now - this.returnFedAt[index]! > (bus.effects.tail() + RETURN_LINGER) * 1000) {
                this.returnAsleep[index] = true;
                bus.sleep();
            }
        });
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
        this.hibernation?.forget(id);

        if (this.currentContainer.id === id) {
            this.setCurrentContainer(this.containers[Math.min(index, this.containers.length - 1)]!.id);
        }
    }

    /** What a song automation lane drives (the raw object, this runs during playback), or undefined when it was deleted. */
    resolveTarget(target: AutomationTarget): (Automatable & { settle(key: string): void }) | undefined {
        if (target.kind === 'master') {
            return this.master;
        }
        if (target.kind === 'return') {
            return this.returns[target.index];
        }
        const container = this.rawContainer(target.containerId);
        return target.kind === 'container' ? container?.bus : container?.rawTrack(target.trackId);
    }

    /** The container without its reactive proxy, for everything that runs in the audio callback. A plain loop: no closure per call. */
    private rawContainer(id: string): TrackContainer | undefined {
        const containers = toRaw(this.containers);
        for (let i = 0; i < containers.length; i++) {
            const container = toRaw(containers[i]!);
            if (container.id === id) {
                return container;
            }
        }
        return undefined;
    }

    /** Creates a container with copies of all tracks, right after the original. */
    async duplicateContainer(id: string): Promise<TrackContainer | null> {
        const source = this.getContainer(id);
        if (!source) {
            return null;
        }

        const copy = new TrackContainer(`${source.name} copy`);
        copy.connectTo(this.master.input);
        copy.setSendTargets(this.sendTargets);
        await copy.copyFrom(source);
        this.containers.splice(this.containers.indexOf(source) + 1, 0, copy);
        return copy;
    }

    /**
     * Song lanes being recorded (MIDI controllers in song mode), by id: they do not play meanwhile, so the controller
     * is heard, not the old curve. Transient, like `BaseTrack.holdAutomation`.
     */
    private readonly heldSongLanes = new Set<string>();

    /** Stops a song lane from playing while it is recorded. */
    holdSongAutomation(laneId: string): void {
        this.heldSongLanes.add(laneId);
    }

    /** Lets a held song lane play again and puts its parameter back to its stored value until the lane's next step. */
    releaseSongAutomation(laneId: string): void {
        if (!this.heldSongLanes.delete(laneId)) {
            return;
        }
        const lane = toRaw(this.song).automation.find((candidate) => candidate.id === laneId);
        if (lane) {
            this.resolveTarget(lane.target)?.settle(lane.param);
        }
    }

    /** Song lanes for the step window `[step, step + 1)`: the value at the step, then every point inside the window at its own time. */
    private applySongAutomation(song: Song, step: number, time: number): void {
        const lanes = song.automation;
        const held = this.heldSongLanes;
        let stepSeconds = 0;
        for (let l = 0; l < lanes.length; l++) {
            const lane = lanes[l]!;
            if (held.size && held.has(lane.id)) {
                continue;
            }
            const target = this.resolveTarget(lane.target);
            const param = target?.parameter(lane.param);
            const points = lane.points;
            const position = valueAt(points, step);
            if (!target || !param || position === null) {
                continue;
            }
            target.setParameter(lane.param, toValue(param, position), time);
            const end = step + 1;
            for (let i = firstPointAfter(points, step); i < points.length; i++) {
                const point = points[i]!;
                if (point.step >= end) {
                    break;
                }
                stepSeconds ||= 15 / this.transport.bpm.getValueAtTime(time);
                target.setParameter(lane.param, toValue(param, point.value), time + (point.step - step) * stepSeconds);
            }
        }
    }

    private get ticksPerStep(): number {
        // A step is a sixteenth note and PPQ is the number of ticks per quarter note.
        return this.transport.PPQ / 4;
    }

    /** The song step for a running transport step: inside the loop region once it was reached, else wrapped at the song's end. */
    private songStep(absoluteStep: number, songLength: number): number {
        return songStepAt(absoluteStep, songLength, this.loop);
    }

    /** Fills `due` with the containers that play in song mode from `step` on, within the wake window (the loop region and the song's end wrap it). */
    private markDue(step: number, song: Song, songLength: number): void {
        const loop = this.loop;
        const count = upcomingSegments(step, WAKE_WINDOW_STEPS, loop ? loop.start : 0, loop ? loop.end : songLength, this.window);
        this.due.clear();
        markDue(song, this.window, count, this.due);
    }

    private playStep(time: number): void {
        /*
         * The transport runs freely; the play position is derived from its tick count.
         * In loop mode tracks wrap it around their own length. In song mode it wraps at the
         * end of the arrangement, so the song loops, and every clip plays its container from
         * the clip's own start.
         */
        const absoluteStep = Math.round(this.transport.getTicksAtTime(time) / this.ticksPerStep);
        const song = toRaw(this.song);
        const songLength = song.length;
        const step = this.mode === 'song' ? this.songStep(absoluteStep, songLength) : absoluteStep;

        // Before anything plays: a container due at this very step (a seek, a clip dropped at the playhead) wakes first.
        if (this.hibernation) {
            if (this.mode === 'loop') {
                this.due.clear();
                this.due.add(this.currentContainer.id);
            } else {
                this.markDue(step, song, songLength);
            }
            if (this.live.size) {
                for (const id of this.live) {
                    if (this.rawContainer(id)?.hasLiveNotes()) {
                        this.due.add(id);
                    } else {
                        this.live.delete(id);
                    }
                }
            }
            // Waking and sleeping build and free nodes; Tone's own constructors and `dispose` start and stop sources
            // without a time, which Tone warns about inside a scheduled callback. Nothing there is meant to be timed.
            debug.enterScheduledCallback(false);
            try {
                this.hibernation.update(toRaw(this.containers), this.due, time, this.stepSeconds);
            } finally {
                debug.enterScheduledCallback(true);
            }
        }

        if (this.stepHook) {
            this.stepHook(step, time);
        }

        // Once a bar: returns wake for new sends and sleep when nothing has fed them for a while.
        if (this.hibernation && absoluteStep % 16 === 0) {
            this.updateReturns();
        }

        if (this.mode === 'loop') {
            toRaw(this.currentContainer).play(step, time);
        } else {
            for (const [containerId, patternStep] of song.playingAt(step, this.playing)) {
                this.rawContainer(containerId)?.play(patternStep, time);
            }
            // Song lanes come last, so they win over a track's own step lanes for the same parameter.
            this.applySongAutomation(song, step, time);
        }

        // The callback fires ahead of time (transport look-ahead), so UI updates are deferred until the step is heard.
        if (this.stepListeners.size) {
            this.draw.schedule(() => this.notifyStep(step), time);
        }
    }

    private notifyStep(step: number): void {
        for (const listener of this.stepListeners) {
            listener(step);
        }
    }
}
