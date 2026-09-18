import { Context, getTransport, setContext, start, type TransportInstance } from 'tone';
import type { Automatable, AutomationTarget } from './automation';
import { DEFAULT_BPM } from './constants';
import type { MixBus } from './mixBus';
import { Sequencer, type PlaybackMode, type SessionState, type StepListener } from './sequencer';
import type { TrackContainer } from './trackContainer';
import { SampleTrack } from './tracks/SampleTrack';

/**
 * Facade over Tone's transport and the sequencer.
 *
 * This module (and everything under `src/juicyloops`) knows nothing about the UI.
 * The Vue side talks to it through `useJuicyLoops` only.
 */
/*
 * Notes are scheduled this far ahead of time. A step sequencer does not need low latency,
 * so a generous window keeps the audio steady while the main thread is busy with the UI.
 */
const LOOK_AHEAD_SECONDS = 0.2;

setContext(new Context({ latencyHint: 'balanced', lookAhead: LOOK_AHEAD_SECONDS }));

export class Engine {
    readonly transport: TransportInstance = getTransport();
    readonly sequencer = new Sequencer();

    private isInitialized = false;

    constructor() {
        this.transport.bpm.value = DEFAULT_BPM;
    }

    /** Unlocks the audio context (must be triggered by a user gesture) and starts the sequencer. */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        await start();
        this.sequencer.start();
        this.isInitialized = true;
    }

    play(): void {
        this.transport.start();
    }

    /** Stops, and puts every automated value back to what its knob says. */
    stop(): void {
        this.transport.stop();
        this.sequencer.settleAutomation();
    }

    setBpm(bpm: number): void {
        this.transport.bpm.value = bpm;
    }

    get song() {
        return this.sequencer.song;
    }

    /** The master channel with its effect rack and level. */
    get master(): MixBus {
        return this.sequencer.master;
    }

    setMode(mode: PlaybackMode): void {
        this.sequencer.setMode(mode);
    }

    seekToStep(step: number): void {
        this.sequencer.seekToStep(step);
    }

    /** What a song automation lane drives, or undefined when it was deleted. */
    resolveTarget(target: AutomationTarget): (Automatable & { settle(key: string): void }) | undefined {
        return this.sequencer.resolveTarget(target);
    }

    /* ---- history ---- */

    capture(): SessionState {
        return this.sequencer.capture();
    }

    restore(state: SessionState): void {
        this.sequencer.restore(state);
    }

    /**
     * Replaces the whole session with a loaded one: playback stops, the state is taken over and the samples
     * are decoded. Resolves once every sample is playable.
     */
    async load(state: SessionState): Promise<void> {
        this.stop();
        this.sequencer.restore(state);
        const tracks = this.sequencer.containers.flatMap((container) => container.tracks);
        await Promise.all(tracks.filter((track): track is SampleTrack => track instanceof SampleTrack).map((track) => track.whenReady()));
    }

    onStep(listener: StepListener): () => void {
        return this.sequencer.onStep(listener);
    }

    get containers(): TrackContainer[] {
        return this.sequencer.containers;
    }

    get currentContainer(): TrackContainer {
        return this.sequencer.currentContainer;
    }

    setCurrentContainer(id: string): void {
        this.sequencer.setCurrentContainer(id);
    }

    addContainer(name?: string): TrackContainer {
        return this.sequencer.addContainer(name);
    }

    removeContainer(id: string): void {
        this.sequencer.removeContainer(id);
    }

    duplicateContainer(id: string): Promise<TrackContainer | null> {
        return this.sequencer.duplicateContainer(id);
    }
}

export const engine = new Engine();
