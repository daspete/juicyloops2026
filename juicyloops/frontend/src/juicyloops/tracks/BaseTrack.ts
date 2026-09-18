import { PanVol, type ToneAudioNode } from 'tone';
import { markRaw } from 'vue';
import { createId } from '../audio';
import { MIX_PARAMS, toNormalized, toValue, TrackAutomation, valueAt, type Automatable, type AutomationParam, type StepAutomationLane, type StepAutomationSnapshot } from '../automation';
import { normalizeTrackLength, PARAM_RAMP_TIME, STEP_COUNT } from '../constants';
import { EFFECT_PARAMS, Effects, type EffectsSnapshot } from '../effects/effects';
import type { BaseTick, TickSnapshot } from '../ticks/BaseTick';
import type { TrackType } from './registry';

export interface TrackSnapshot {
    id: string;
    type: TrackType;
    ticks: TickSnapshot[];
    volume: number;
    pan: number;
    automation: StepAutomationSnapshot[];
}

/** Everything about a track that history keeps: what `serialize` gives, minus decoded audio, plus what the user can change. */
export interface TrackState extends TrackSnapshot {
    isMuted: boolean;
    effects: EffectsSnapshot;
}

/**
 * Common behaviour of every track: a row of ticks, an effect chain and a volume/pan stage that feeds the container's bus.
 *
 * Every track has its own length. The sequencer hands every track the same running step,
 * and the track wraps it around its own pattern, so a 16-step track repeats twice per section
 * and a 48-step one stretches over one and a half.
 *
 * Every value that can be turned (level, pan, the effects, and whatever a subclass adds) is a parameter
 * automation can drive: step lanes on the track itself, and lanes on the song's timeline.
 *
 * Tone.js nodes are wrapped in `markRaw` so Vue's reactivity never proxies them
 * (they are expensive to proxy and rely on private state). Everything else on a track
 * is plain data and can be observed by the UI.
 */
export abstract class BaseTrack<TTick extends BaseTick = BaseTick> implements Automatable {
    readonly id: string;

    abstract readonly type: TrackType;

    readonly ticks: TTick[];

    readonly effects = markRaw(new Effects());

    /** Step lanes: one value per step for every automated parameter, looping with the pattern. */
    readonly automation = new TrackAutomation(STEP_COUNT);

    /** Volume (dB) and pan (-1..1) stage at the end of the chain. */
    protected readonly output = markRaw(new PanVol(0, 0));

    volume = 0;
    pan = 0;
    isMuted = false;

    constructor(id = createId()) {
        this.id = id;
        this.ticks = Array.from({ length: STEP_COUNT }, () => this.createTick());
    }

    protected abstract createTick(): TTick;

    /** Length of the pattern in steps. */
    get length(): number {
        return this.ticks.length;
    }

    /** Changes the length of the pattern. New steps start silent, removed steps are gone. Automation lanes follow. */
    setLength(length: number): void {
        const target = normalizeTrackLength(length);
        if (target > this.ticks.length) {
            this.ticks.push(...Array.from({ length: target - this.ticks.length }, () => this.createTick()));
        } else {
            this.ticks.splice(target);
        }
        this.automation.resize(target);
    }

    /** The position inside this pattern for a running step count. */
    stepOf(step: number): number {
        return ((step % this.ticks.length) + this.ticks.length) % this.ticks.length;
    }

    /** Called by the sequencer for every step: applies the step's automation, then plays whatever the tick holds. */
    play(step: number, time: number): void {
        this.applyAutomation(this.stepOf(step), time);
        this.trigger(step, time);
    }

    /** Makes the sound of a step. `step` keeps counting past the pattern; `time` is the audio-context time to schedule at. */
    protected abstract trigger(step: number, time: number): void;

    /** Wires `source -> effects -> output`. Subclasses call this once with their sound source; `connectTo` decides where the output goes. */
    protected connectSource(source: ToneAudioNode): void {
        this.effects.connect(source, this.output);
    }

    /** Sends the track into a node (its container's bus), replacing where it went before. */
    connectTo(destination: ToneAudioNode): void {
        this.output.disconnect();
        this.output.connect(destination);
    }

    /** Returns the tick for a step if it should sound, otherwise null. */
    protected activeTick(step: number): TTick | null {
        if (this.isMuted) {
            return null;
        }

        const tick = this.ticks[this.stepOf(step)];
        return tick?.isActive ? tick : null;
    }

    /** With a `time` the level is only played, not stored (automation); see `settle`. */
    setVolume(volume: number, time?: number): void {
        this.output.volume.rampTo(volume, PARAM_RAMP_TIME, time);
        if (time === undefined) {
            this.volume = volume;
        }
    }

    setPan(pan: number, time?: number): void {
        this.output.pan.rampTo(pan, PARAM_RAMP_TIME, time);
        if (time === undefined) {
            this.pan = pan;
        }
    }

    toggleMute(): void {
        this.isMuted = !this.isMuted;
    }

    /* ---- parameters and automation ---- */

    /** Everything automation can drive on this track. Subclasses add their own in `ownParameters`. */
    get parameters(): readonly AutomationParam[] {
        return [...MIX_PARAMS, ...this.ownParameters(), ...EFFECT_PARAMS];
    }

    /** Parameters specific to a track type (a synth's envelope, ...). */
    protected ownParameters(): readonly AutomationParam[] {
        return [];
    }

    parameter(key: string): AutomationParam | undefined {
        return this.parameters.find((param) => param.key === key);
    }

    getParameter(key: string): number {
        if (key === 'volume') {
            return this.volume;
        }
        if (key === 'pan') {
            return this.pan;
        }
        return this.effects.getParameter(key);
    }

    setParameter(key: string, value: number, time?: number): void {
        if (key === 'volume') {
            this.setVolume(value, time);
        } else if (key === 'pan') {
            this.setPan(value, time);
        } else {
            this.effects.setParameter(key, value, time);
        }
    }

    /** Puts the stored value of a parameter back on the sound, after automation moved it. */
    settle(key: string): void {
        this.setParameter(key, this.getParameter(key));
    }

    /** Puts every automated parameter of this track back to its stored value. */
    settleAll(): void {
        for (const lane of this.automation.lanes) {
            this.settle(lane.param);
        }
    }

    /** Adds a step lane for a parameter, flat at the parameter's current value, so the sound does not change until you draw. */
    addAutomation(key: string): StepAutomationLane | null {
        const param = this.parameter(key);
        return param ? this.automation.add(key, toNormalized(param, this.getParameter(key))) : null;
    }

    private applyAutomation(index: number, time: number): void {
        for (const lane of this.automation.lanes) {
            const param = this.parameter(lane.param);
            const position = valueAt(lane.points, index);
            if (param && position !== null) {
                this.setParameter(lane.param, toValue(param, position), time);
            }
        }
    }

    /* ---- pattern tools ---- */

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

    /** Copies the pattern, effects, automation and settings of another track of the same type onto this one. */
    async copyFrom(source: this): Promise<void> {
        this.setLength(source.length);
        source.ticks.forEach((tick, index) => {
            this.ticks[index] = tick.clone();
        });
        this.effects.copyFrom(source.effects);
        this.automation.copyFrom(source.automation);
        this.setVolume(source.volume);
        this.setPan(source.pan);
    }

    dispose(): void {
        this.effects.dispose();
        this.output.dispose();
    }

    /* ---- history ---- */

    /** The track as history keeps it. Synchronous, and cheap: no audio is copied. */
    capture(): TrackState {
        return {
            id: this.id,
            type: this.type,
            ticks: this.ticks.map((tick) => tick.serialize()),
            volume: this.volume,
            pan: this.pan,
            isMuted: this.isMuted,
            effects: this.effects.capture(),
            automation: this.automation.serialize(),
        };
    }

    /** Takes a captured state back. Ticks keep their objects, so the grid does not re-render from scratch. */
    restore(state: TrackState): void {
        this.setLength(state.ticks.length);
        state.ticks.forEach((tick, index) => this.ticks[index]!.restore(tick));
        this.setVolume(state.volume);
        this.setPan(state.pan);
        this.isMuted = state.isMuted;
        this.effects.restore(state.effects);
        this.automation.restore(state.automation);
    }

    async serialize(): Promise<TrackSnapshot> {
        return {
            id: this.id,
            type: this.type,
            ticks: this.ticks.map((tick) => tick.serialize()),
            volume: this.volume,
            pan: this.pan,
            automation: this.automation.serialize(),
        };
    }
}
