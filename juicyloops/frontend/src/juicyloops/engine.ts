import { Context, getTransport, setContext, start, type TransportInstance } from 'tone';
import { DEFAULT_BPM } from './constants';
import { Sequencer, type PlaybackMode, type StepListener } from './sequencer';
import type { TrackContainer } from './trackContainer';

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

    stop(): void {
        this.transport.stop();
    }

    setBpm(bpm: number): void {
        this.transport.bpm.value = bpm;
    }

    get song() {
        return this.sequencer.song;
    }

    setMode(mode: PlaybackMode): void {
        this.sequencer.setMode(mode);
    }

    seekToSection(index: number): void {
        this.sequencer.seekToSection(index);
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
