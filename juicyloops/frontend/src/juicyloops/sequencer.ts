import { getDraw, Sequence } from 'tone';
import { STEP_COUNT, STEP_SUBDIVISION } from './constants';
import type { BaseTrack } from './tracks/BaseTrack';
import { createTrack, type TrackOf, type TrackType } from './tracks/registry';

export type StepListener = (step: number) => void;

const STEPS = Array.from({ length: STEP_COUNT }, (_, i) => i);

/** Owns the tracks and drives them from a Tone `Sequence` on the transport. */
export class Sequencer {
    readonly tracks: BaseTrack[] = [];

    private sequence: Sequence<number> | null = null;
    private readonly stepListeners = new Set<StepListener>();

    /** Creates the sequence on the transport. Safe to call more than once. */
    start(): void {
        if (this.sequence) {
            return;
        }

        this.sequence = new Sequence<number>((time, step) => this.playStep(time, step), STEPS, STEP_SUBDIVISION).start(0);
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
    }

    /** Creates a new track of the same type with the same pattern and settings. */
    async duplicateTrack(id: string): Promise<BaseTrack | null> {
        const source = this.getTrack(id);
        if (!source) {
            return null;
        }

        const copy: BaseTrack = this.addTrack(source.type);
        await copy.copyFrom(source);
        return copy;
    }

    private playStep(time: number, step: number): void {
        for (const track of this.tracks) {
            track.play(step, time);
        }

        // The callback fires ahead of time (transport look-ahead), so UI updates are deferred until the step is heard.
        getDraw().schedule(() => this.stepListeners.forEach((listener) => listener(step)), time);
    }
}
