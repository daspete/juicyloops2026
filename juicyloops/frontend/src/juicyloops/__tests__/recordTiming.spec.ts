import { describe, expect, it } from 'vitest';
import { heardNowFromStamp, heardTime, patternPosition, transportStepAt, type ClockReading, type PlayState, type TransportClock } from '../midi/recordTiming';
import { Song, songStepAt } from '../song';

/** A clock pair: the output was at context time 10 s at performance time 5000 ms; now is 5020 ms, the render at 10.05 s. */
const clock = (overrides: Partial<ClockReading> = {}): ClockReading => ({
    output: { contextTime: 10, performanceTime: 5000 },
    currentTime: 10.05,
    now: 5020,
    latency: 0.03,
    ...overrides,
});

/** A transport that started at context time 2 s at 120 BPM (a step is 0.125 s), from running step `from`. */
const transport = (startTime = 2, stepSeconds = 0.125, from = 0): TransportClock => ({
    isPlayingAt: (time) => time >= startTime,
    stepAt: (time) => from + Math.max(0, time - startTime) / stepSeconds,
});

const loopState = (currentContainerId = 'c1'): PlayState => ({ mode: 'loop', currentContainerId, song: new Song(), songLength: 0, loop: null });

describe('heard time (output latency mapping)', () => {
    it('maps a time stamp through the output stamp: what was heard then, not what was being computed', () => {
        // 5010 ms is 10 ms after the stamp: the output was at 10.010 s, though the render was ahead of that.
        expect(heardTime(5010, clock())).toBeCloseTo(10.01, 9);
        expect(heardTime(4990, clock())).toBeCloseTo(9.99, 9);
        expect(heardNowFromStamp(clock())).toBeCloseTo(10.02, 9);
    });

    it('adds the record offset (ms): positive later, negative earlier', () => {
        expect(heardTime(5010, clock(), 15)).toBeCloseTo(10.025, 9);
        expect(heardTime(5010, clock(), -15)).toBeCloseTo(9.995, 9);
    });

    it('falls back to the latency figures when there is no usable output stamp', () => {
        // Heard now = currentTime - latency = 10.02; 5010 ms is 10 ms before now.
        expect(heardTime(5010, clock({ output: null }))).toBeCloseTo(10.01, 9);
        // Zeros (no output yet), a stamp ahead of the render, a stamp seconds behind: not trusted.
        expect(heardNowFromStamp(clock({ output: { contextTime: 0, performanceTime: 0 } }))).toBeNull();
        expect(heardNowFromStamp(clock({ output: { contextTime: 10.2, performanceTime: 5000 } }))).toBeNull();
        expect(heardNowFromStamp(clock({ output: { contextTime: 8, performanceTime: 5000 } }))).toBeNull();
        expect(heardTime(5010, clock({ output: { contextTime: 10.2, performanceTime: 5000 } }))).toBeCloseTo(10.01, 9);
    });
});

describe('transport step at a heard time', () => {
    it('is the fractional running step while the transport plays, null before it started', () => {
        const clockOf = transport();
        expect(transportStepAt(2.5, clockOf, null)).toBeCloseTo(4, 9);
        expect(transportStepAt(2.53, clockOf, null)).toBeCloseTo(4.24, 9);
        expect(transportStepAt(1.9, clockOf, null)).toBeNull();
    });

    it('counts a note a hair before a count-in downbeat as on it (the grace), nothing earlier', () => {
        const start = { time: 2, step: 0, grace: 0.125 };
        expect(transportStepAt(1.95, transport(), start)).toBe(0);
        expect(transportStepAt(1.85, transport(), start)).toBeNull();
        expect(transportStepAt(2.25, transport(), start)).toBeCloseTo(2, 9);
    });

    it('ignores what came before a punch-in', () => {
        const start = { time: 3, step: 8, grace: 0 };
        expect(transportStepAt(2.99, transport(), start)).toBeNull();
        expect(transportStepAt(3.0625, transport(), start)).toBeCloseTo(8.5, 9);
    });
});

describe('pattern position', () => {
    it('loop mode: the running step wrapped by the track length, only for the current container', () => {
        expect(patternPosition(5.25, 'c1', 16, loopState())).toBeCloseTo(5.25, 9);
        expect(patternPosition(37.5, 'c1', 16, loopState())).toBeCloseTo(5.5, 9);
        expect(patternPosition(37.5, 'c1', 12, loopState())).toBeCloseTo(1.5, 9);
        expect(patternPosition(37.5, 'c2', 16, loopState())).toBeNull();
    });

    it('song mode: the clip-relative pattern step of the track container, wrapped by the track length', () => {
        const song = new Song();
        const lane = song.lanes[0]!;
        song.addClip(lane.id, 'c1', 16, 32);
        song.addClip(lane.id, 'c2', 48, 16);
        const state: PlayState = { mode: 'song', currentContainerId: 'c2', song, songLength: song.length, loop: null };
        // Song step 20.5 is 4.5 steps into the clip of c1.
        expect(patternPosition(20.5, 'c1', 16, state)).toBeCloseTo(4.5, 9);
        // 30 steps into the clip: a 16-step track wraps.
        expect(patternPosition(46, 'c1', 16, state)).toBeCloseTo(14, 9);
        // c1 plays nothing at step 50, c2 does; step 10 is before every clip.
        expect(patternPosition(50, 'c1', 16, state)).toBeNull();
        expect(patternPosition(50.25, 'c2', 16, state)).toBeCloseTo(2.25, 9);
        expect(patternPosition(10, 'c1', 16, state)).toBeNull();
        // The song (64 steps) wraps: running step 84.5 is song step 20.5.
        expect(patternPosition(84.5, 'c1', 16, state)).toBeCloseTo(4.5, 9);
    });

    it('song mode: a clip offset and the loop region count', () => {
        const song = new Song();
        const lane = song.lanes[0]!;
        const clip = song.addClip(lane.id, 'c1', 0, 32)!;
        song.setClipStart(clip.id, 8);
        const loop = { start: 8, end: 16 };
        const state: PlayState = { mode: 'song', currentContainerId: 'c1', song, songLength: song.length, loop };
        // Step 9.5 is 1.5 into the clip, whose patterns begin 8 steps in: pattern step 9.5.
        expect(patternPosition(9.5, 'c1', 32, state)).toBeCloseTo(9.5, 9);
        // Running step 17.5 is past the loop end: back to 9.5.
        expect(songStepAt(17.5, song.length, loop)).toBeCloseTo(9.5, 9);
        expect(patternPosition(17.5, 'c1', 32, state)).toBeCloseTo(9.5, 9);
    });

    it('a muted clip is not playing', () => {
        const song = new Song();
        const clip = song.addClip(song.lanes[0]!.id, 'c1', 0, 16)!;
        clip.isMuted = true;
        expect(patternPosition(4, 'c1', 16, { mode: 'song', currentContainerId: 'c1', song, songLength: song.length, loop: null })).toBeNull();
    });
});

describe('the whole chain: time stamp to pattern position', () => {
    it('lands a key pressed as step 4 was heard on step 4, whatever the output latency', () => {
        // The transport started at context time 10 s; step 4 (0.5 s later) is heard at 10.5 s. The output runs 40 ms
        // behind the render: at performance time 7000 ms the render is at 10.54 s but 10.5 s comes out of the speakers.
        const reading = clock({ output: { contextTime: 10.5, performanceTime: 7000 }, currentTime: 10.54, now: 7000 });
        const heard = heardTime(7000, reading);
        const step = transportStepAt(heard, transport(10), { time: 10, step: 0, grace: 0 });
        expect(patternPosition(step!, 'c1', 16, loopState())).toBeCloseTo(4, 9);
        // Mapped by the render clock instead, it would land 40 ms (a third of a step) late.
        expect(transport(10).stepAt(reading.currentTime)).toBeCloseTo(4.32, 9);
    });
});
