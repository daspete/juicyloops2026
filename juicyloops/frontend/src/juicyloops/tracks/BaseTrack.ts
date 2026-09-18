import { PanVol, type ToneAudioNode } from 'tone';
import { markRaw } from 'vue';
import { createId } from '../audio';
import { PARAM_RAMP_TIME, STEP_COUNT } from '../constants';
import { Effects } from '../effects/effects';
import type { BaseTick, TickSnapshot } from '../ticks/BaseTick';
import type { TrackType } from './registry';

export interface TrackSnapshot {
    id: string;
    type: TrackType;
    ticks: TickSnapshot[];
    volume: number;
    pan: number;
}

/**
 * Common behaviour of every track: a row of ticks, an effect chain and a volume/pan stage.
 *
 * Tone.js nodes are wrapped in `markRaw` so Vue's reactivity never proxies them
 * (they are expensive to proxy and rely on private state). Everything else on a track
 * is plain data and can be observed by the UI.
 */
export abstract class BaseTrack<TTick extends BaseTick = BaseTick> {
    readonly id = createId();

    abstract readonly type: TrackType;

    readonly ticks: TTick[];

    readonly effects = markRaw(new Effects());

    /** Volume (dB) and pan (-1..1) stage at the end of the chain. */
    protected readonly output = markRaw(new PanVol(0, 0));

    volume = 0;
    pan = 0;
    isMuted = false;

    constructor() {
        this.ticks = Array.from({ length: STEP_COUNT }, () => this.createTick());
    }

    protected abstract createTick(): TTick;

    /** Called by the sequencer for every step. `time` is the audio-context time to schedule at. */
    abstract play(step: number, time: number): void;

    /** Wires `source -> effects -> output -> speakers`. Subclasses call this once with their sound source. */
    protected connectSource(source: ToneAudioNode): void {
        this.effects.connect(source, this.output);
        this.output.toDestination();
    }

    /** Returns the tick for a step if it should sound, otherwise null. */
    protected activeTick(step: number): TTick | null {
        if (this.isMuted) {
            return null;
        }

        const tick = this.ticks[step];
        return tick?.isActive ? tick : null;
    }

    setVolume(volume: number): void {
        this.output.volume.rampTo(volume, PARAM_RAMP_TIME);
        this.volume = volume;
    }

    setPan(pan: number): void {
        this.output.pan.rampTo(pan, PARAM_RAMP_TIME);
        this.pan = pan;
    }

    toggleMute(): void {
        this.isMuted = !this.isMuted;
    }

    /** Activates every n-th tick and deactivates all others. */
    activateEveryNth(interval: number): void {
        this.ticks.forEach((tick, index) => {
            tick.isActive = index % interval === 0;
        });
    }

    /** Deactivates every tick. */
    clear(): void {
        this.ticks.forEach((tick) => (tick.isActive = false));
    }

    /** Activates a random selection of ticks. `density` is the share of ticks that end up active (0..1). */
    randomize(density = 0.4): void {
        this.ticks.forEach((tick) => (tick.isActive = Math.random() < density));
    }

    /** Rotates the pattern by one step to the right (`1`) or to the left (`-1`). */
    rotateTicks(direction: 1 | -1): void {
        if (direction === 1) {
            this.ticks.unshift(this.ticks.pop()!);
        } else {
            this.ticks.push(this.ticks.shift()!);
        }
    }

    /** Copies the pattern, effects and settings of another track of the same type onto this one. */
    async copyFrom(source: this): Promise<void> {
        source.ticks.forEach((tick, index) => {
            this.ticks[index] = tick.clone();
        });
        this.effects.copyFrom(source.effects);
        this.setVolume(source.volume);
        this.setPan(source.pan);
    }

    dispose(): void {
        this.effects.dispose();
        this.output.dispose();
    }

    async serialize(): Promise<TrackSnapshot> {
        return {
            id: this.id,
            type: this.type,
            ticks: this.ticks.map((tick) => tick.serialize()),
            volume: this.volume,
            pan: this.pan,
        };
    }
}
