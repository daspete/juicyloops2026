import { toRaw } from 'vue';
import { SAMPLE_ROOT_NOTE, semitonesBetween } from './notes';
import { SONG_STEPS_PER_BAR, type Song } from './song';
import type { BaseTrack } from './tracks/BaseTrack';
import { SampleTrack } from './tracks/SampleTrack';
import { SynthTrack } from './tracks/SynthTrack';

/**
 * Hibernating idle containers.
 *
 * A container that is not heard still costs: its effects (a reverb's convolver, a delay, LFOs) and its synth voices
 * are processed by the browser whether or not a note plays. So a container that has nothing to play goes to sleep:
 * its bus leaves the master and its racks and synth engines are thrown away (the values stay). It wakes up again
 * before it is heard:
 *
 * - loop mode plays only the current container, so every other one sleeps once its tail has rung out;
 * - song mode looks ahead `WAKE_WINDOW_STEPS` and wakes a container as soon as one of its clips starts in that
 *   window, and puts it to sleep once no clip is due any more and its tail has rung out.
 *
 * The sequencer drives this from its step callback (`Hibernation.update`); the pure parts live here so they can be tested.
 * An offline render never hibernates: every container there stays awake for the whole render.
 */

/** How far ahead song mode wakes containers: two bars, so a reverb has long rebuilt its impulse response when the clip starts. */
export const WAKE_WINDOW_STEPS = 2 * SONG_STEPS_PER_BAR;

/** A container rings for at least this long (seconds) after its last step before it sleeps. */
export const MIN_TAIL = 1;

/** Added to every tail (seconds), because it is estimated from stored values and must rather be long than short. */
export const TAIL_MARGIN = 0.5;

/**
 * The song steps the next `length` steps of playback from `step` pass through, as `[start, end)` pairs written into
 * `into` (reused, so the step callback does not allocate). Returns how many pairs were written: one, or two when the
 * window wraps from `wrapEnd` back to `wrapStart` (the end of the song, or of the loop region).
 */
export const upcomingSegments = (step: number, length: number, wrapStart: number, wrapEnd: number, into: number[]): number => {
    const end = step + length;
    if (end <= wrapEnd || wrapEnd <= wrapStart || step >= wrapEnd) {
        into[0] = step;
        into[1] = end;
        return 1;
    }
    into[0] = step;
    into[1] = wrapEnd;
    into[2] = wrapStart;
    into[3] = Math.min(wrapEnd, wrapStart + (end - wrapEnd));
    return 2;
};

/**
 * Adds to `into` every container with an audible clip in one of the segments (see `upcomingSegments`). Muted clips
 * and lanes, and lanes silenced by a solo, count as not there, the same as `Song.playingAt`.
 */
export const markDue = (song: Song, segments: readonly number[], count: number, into: Set<string>): Set<string> => {
    const lanes = song.lanes;
    let hasSolo = false;
    for (let i = 0; i < lanes.length; i++) {
        hasSolo ||= lanes[i]!.isSolo === true;
    }
    for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i]!;
        if (hasSolo ? !lane.isSolo : lane.isMuted) {
            continue;
        }
        const clips = lane.clips;
        for (let j = 0; j < clips.length; j++) {
            const clip = clips[j]!;
            if (clip.isMuted) {
                continue;
            }
            for (let s = 0; s < count; s++) {
                if (clip.start < segments[s * 2 + 1]! && clip.start + clip.length > segments[s * 2]!) {
                    into.add(clip.containerId);
                    break;
                }
            }
        }
    }
    return into;
};

/**
 * How long (seconds) one track's own sound can go on after the step that started it, before its effects: the longest
 * synth note plus its release (a note may start up to a step late inside its step), a sample voice's full length
 * (in gate mode it may stop earlier). Estimated from the stored values, on the long side.
 */
export const voiceTail = (track: BaseTrack, stepSeconds: number): number => {
    if (track instanceof SynthTrack) {
        const longest = track.notes.length ? track.longestNote + 1 : 0;
        return longest * stepSeconds + track.envelope.release;
    }
    if (track instanceof SampleTrack) {
        // A voice plays at most the whole region, at the speed; an unsliced sample plays lower notes slower, so longer.
        let slowest = 1;
        if (!track.isSliced) {
            for (const note of track.notes) {
                slowest = Math.max(slowest, 2 ** (-semitonesBetween(SAMPLE_ROOT_NOTE, note.note) / 12));
            }
        }
        return (track.sampleDuration / Math.max(track.speed, 1e-3)) * slowest;
    }
    return 0;
};

/** What the hibernation needs of a container. `TrackContainer` is one. */
export interface Sleeper {
    readonly id: string;
    readonly isAwake: boolean;
    sleep(): void;
    wake(): void;
    /** Seconds the container can still sound after its last step. */
    tail(stepSeconds: number): number;
}

/** Marks a container that must not sleep before it has been out of use for its tail. */
const IN_USE = Number.POSITIVE_INFINITY;

/**
 * The wake/sleep policy over time. `update` runs on every step with the containers that are due (playing now, or
 * starting soon); each one is awake while due, and sleeps once it has not been due for its tail. The tail is taken
 * when a container stops being due, from the values it has then.
 */
export class Hibernation {
    /** Per container: `IN_USE` while due, then the time it may sleep at. Containers never used since tracking are missing. */
    private readonly sleepAt = new Map<string, number>();

    /**
     * Runs in the step callback, so it allocates nothing and touches the containers through their raw objects only.
     * `time` is the audio time of the step, `stepSeconds` how long a step lasts (only asked for when a tail is taken).
     */
    update(containers: readonly Sleeper[], due: ReadonlySet<string>, time: number, stepSeconds: () => number): void {
        for (let i = 0; i < containers.length; i++) {
            const container = toRaw(containers[i]!);
            const id = container.id;
            if (due.has(id)) {
                this.wake(container);
                continue;
            }
            if (!container.isAwake) {
                continue;
            }
            let at = this.sleepAt.get(id);
            if (at === IN_USE) {
                at = time + Math.max(MIN_TAIL, container.tail(stepSeconds())) + TAIL_MARGIN;
                this.sleepAt.set(id, at);
            }
            if (at === undefined || time >= at) {
                container.sleep();
                this.sleepAt.delete(id);
            }
        }
    }

    /** Wakes a container now and keeps it awake until it has been out of use for its tail (a switch, a seek). */
    wake(container: Sleeper): void {
        const raw = toRaw(container);
        this.sleepAt.set(raw.id, IN_USE);
        if (!raw.isAwake) {
            raw.wake();
        }
    }

    /** Forgets a container that was removed. */
    forget(id: string): void {
        this.sleepAt.delete(id);
    }
}
