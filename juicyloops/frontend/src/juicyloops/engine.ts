import { getTransport, start, type TransportInstance } from 'tone';
import { DEFAULT_BPM } from './constants';
import { Sequencer, type PlaybackMode, type StepListener } from './sequencer';
import type { TrackOf, TrackType } from './tracks/registry';

/**
 * Facade over Tone's transport and the sequencer.
 *
 * This module (and everything under `src/juicyloops`) knows nothing about the UI.
 * The Vue side talks to it through `useJuicyLoops` only.
 */
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

    addTrack<T extends TrackType>(type: T): TrackOf<T> {
        return this.sequencer.addTrack(type);
    }

    removeTrack(id: string): void {
        this.sequencer.removeTrack(id);
    }

    duplicateTrack(id: string) {
        return this.sequencer.duplicateTrack(id);
    }
}

export const engine = new Engine();
