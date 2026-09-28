import { wrapStart } from '../notes/Note';
import { songStepAt } from '../song';

/**
 * Recording: from the moment a key went down to a position in a pattern. Pure functions, no audio, no Vue.
 *
 * 1. A MIDI event carries `timeStamp` in the `performance.now()` clock (ms).
 * 2. `heardTime` turns it into the audio-context time that was coming out of the speakers at that moment, with
 *    `context.getOutputTimestamp()` (a pair of matching readings of both clocks at the output). What the player
 *    reacted to is what they heard, not what the context was computing (that runs ahead by the output latency).
 * 3. The transport turns that context time into ticks and so into a running step (`transportStepAt`), which is
 *    fractional: notes keep the timing they were played with.
 * 4. `patternPosition` finds where that step lands in a track's pattern: in loop mode the running step wrapped by
 *    the track's length; in song mode the clip-relative pattern step of the track's container (`Song.playingAt`),
 *    or nothing when the container is not playing there (then the note is heard, but not recorded).
 */

/** What `AudioContext.getOutputTimestamp()` returns: `contextTime` (s) was at the output at `performanceTime` (ms). */
export interface OutputStamp {
    contextTime?: number;
    performanceTime?: number;
}

/** Readings of the clocks, taken together when an event is handled. */
export interface ClockReading {
    /** `context.getOutputTimestamp()`, or null when the browser has none. */
    output: OutputStamp | null;
    /** `context.currentTime` (s). */
    currentTime: number;
    /** `performance.now()` (ms), read with `currentTime`. */
    now: number;
    /** `baseLatency + outputLatency` (s), used when the output stamp is missing or implausible. */
    latency: number;
}

/**
 * How far behind `currentTime` the output may plausibly be. Output stamps outside this (or ahead of `currentTime`)
 * are not trusted: some devices report zeros or stale pairs, and the latency figures are used instead.
 */
const MAX_OUTPUT_LAG = 0.5;

/** The context time heard at `performance.now() === now`, from an output stamp, or null when the stamp is unusable. */
export const heardNowFromStamp = (clock: ClockReading): number | null => {
    const { output } = clock;
    if (!output || !Number.isFinite(output.contextTime) || !Number.isFinite(output.performanceTime) || !output.performanceTime) {
        return null;
    }
    const heardNow = output.contextTime! + (clock.now - output.performanceTime!) / 1000;
    // A stamp can lag the render a little; it cannot be ahead of it, and it cannot be seconds behind.
    if (heardNow > clock.currentTime + 0.005 || heardNow < clock.currentTime - MAX_OUTPUT_LAG) {
        return null;
    }
    return heardNow;
};

/**
 * The audio-context time that was being heard when an event with `timeStamp` (performance clock, ms) arrived, plus
 * the user's record offset (ms; positive moves recorded notes later, negative earlier).
 */
export const heardTime = (timeStamp: number, clock: ClockReading, offsetMs = 0): number => {
    const heardNow = heardNowFromStamp(clock) ?? clock.currentTime - clock.latency;
    return heardNow - (clock.now - timeStamp) / 1000 + offsetMs / 1000;
};

/** What the recorder needs of the transport. */
export interface TransportClock {
    /** Whether the transport runs at a context time. */
    isPlayingAt(time: number): boolean;
    /** The running step (ticks / ticks per step, fractional) at a context time. */
    stepAt(time: number): number;
}

/** Where a take began: the context time of its first step and the running step there. */
export interface TakeStart {
    time: number;
    step: number;
    /**
     * Seconds before `time` in which a note still counts as played on the take's first step: a player hitting the
     * downbeat right after a count-in is often a hair early. Zero when recording was punched in while playing.
     */
    grace: number;
}

/**
 * The running step at a (heard) context time, or null when nothing was playing then. Before the take began the time
 * is outside the take (null), except within the grace before its start, which counts as its first step.
 */
export const transportStepAt = (time: number, clock: TransportClock, start: TakeStart | null): number | null => {
    if (start && time < start.time) {
        return time >= start.time - start.grace ? start.step : null;
    }
    return clock.isPlayingAt(time) ? clock.stepAt(time) : null;
};

/** What decides where a running step lands: the play mode and, in song mode, the arrangement. */
export interface PlayState {
    mode: 'loop' | 'song';
    /** The container loop mode plays. */
    currentContainerId: string;
    /** The arrangement, for song mode. */
    song: { playingAt(step: number, into?: Map<string, number>): Map<string, number> };
    songLength: number;
    loop: { start: number; end: number } | null;
}

/**
 * The position inside a track's pattern (0 <= p < trackLength) that a running step plays, or null when the track's
 * container is not playing there: another container in loop mode, no clip of it at that point of the song.
 */
export const patternPosition = (step: number, containerId: string, trackLength: number, play: PlayState, into?: Map<string, number>): number | null => {
    if (play.mode === 'loop') {
        return containerId === play.currentContainerId ? wrapStart(step, trackLength) : null;
    }
    const songStep = songStepAt(step, play.songLength, play.loop);
    const patternStep = play.song.playingAt(songStep, into).get(containerId);
    return patternStep === undefined ? null : wrapStart(patternStep, trackLength);
};

/**
 * The song step a running step plays (song mode: the loop region and the song's end wrap it, as the sequencer does),
 * for song automation lanes, which span the whole timeline: whether a clip plays there does not matter. Null in loop
 * mode (there is no timeline) and when the song is empty.
 */
export const songPosition = (step: number, play: PlayState): number | null => {
    if (play.mode !== 'song' || (!play.songLength && !play.loop)) {
        return null;
    }
    return songStepAt(step, play.songLength, play.loop);
};

/** Where song positions jump back: the loop region, else the song's end to its start. */
export const songWrap = (play: PlayState): { start: number; end: number } => play.loop ?? { start: 0, end: play.songLength };
