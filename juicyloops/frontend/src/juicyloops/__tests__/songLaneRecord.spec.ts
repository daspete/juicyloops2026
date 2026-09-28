import { describe, expect, it } from 'vitest';
import { valueAt, type AutomationPoint, type AutomationTarget } from '../automation';
import { CC_MAX_PER_STEP, clearLaneStep, ControllerThinner, HOLD_GAP, inStretch, LaneWriter, SongReplacePass, songLaneFor, TakePoints, writeRecordedPoint } from '../midi/laneRecord';
import { songPosition, songWrap, type PlayState } from '../midi/recordTiming';
import { Song } from '../song';

/** A song with one clip of c1 at steps 16..48 (the song is 48 steps long). */
const songState = (loop: { start: number; end: number } | null = null): PlayState => {
    const song = new Song();
    song.addClip(song.lanes[0]!.id, 'c1', 16, 32);
    return { mode: 'song', currentContainerId: 'c1', song, songLength: song.length, loop };
};

const master: AutomationTarget = { kind: 'master' };
const bus: AutomationTarget = { kind: 'container', containerId: 'c1' };
const track: AutomationTarget = { kind: 'track', containerId: 'c1', trackId: 't1' };

describe('song position of a recorded controller', () => {
    it('is the song step heard, clip or no clip', () => {
        const state = songState();
        // Before the clip: nothing plays there, the song lane still records.
        expect(songPosition(4.25, state)).toBeCloseTo(4.25, 9);
        expect(songPosition(20.5, state)).toBeCloseTo(20.5, 9);
    });

    it('wraps at the song end, or inside the loop region once it was reached, as playback does', () => {
        expect(songPosition(52.5, songState())).toBeCloseTo(4.5, 9);
        const looped = songState({ start: 8, end: 16 });
        expect(songPosition(6, looped)).toBeCloseTo(6, 9);
        expect(songPosition(17.5, looped)).toBeCloseTo(9.5, 9);
        expect(songWrap(looped)).toEqual({ start: 8, end: 16 });
        expect(songWrap(songState())).toEqual({ start: 0, end: 48 });
    });

    it('is null in loop mode (no timeline: played live only) and for an empty song', () => {
        const song = new Song();
        expect(songPosition(4, { mode: 'loop', currentContainerId: 'c1', song, songLength: 0, loop: null })).toBeNull();
        expect(songPosition(4, { mode: 'song', currentContainerId: 'c1', song, songLength: 0, loop: null })).toBeNull();
    });
});

describe('finding or making the song lane', () => {
    it('makes a lane for (target, parameter) that holds the value the take began with until the first recorded point', () => {
        const song = new Song();
        const { lane, start } = songLaneFor(song, bus, 'volume', 0.8);
        expect(song.automation).toHaveLength(1);
        expect(lane.target).toEqual(bus);
        expect(lane.param).toBe('volume');
        expect(start).toEqual({ step: 0, value: 0.8, shape: 'hold' });
        writeRecordedPoint(lane.points, { step: 20, value: 0.1 }, null, () => false);
        // Flat at 0.8 right up to the move, not a ramp from the song's start.
        expect(valueAt(lane.points, 0)).toBeCloseTo(0.8, 9);
        expect(valueAt(lane.points, 19.9)).toBeCloseTo(0.8, 9);
        expect(valueAt(lane.points, 20)).toBeCloseTo(0.1, 9);
    });

    it('finds an existing lane by target and parameter, and keeps different targets apart', () => {
        const song = new Song();
        const existing = song.addAutomation(master, 'volume');
        existing.points.push({ step: 4, value: 0.3 });
        expect(songLaneFor(song, { kind: 'master' }, 'volume', 0.9)).toEqual({ lane: existing, start: null });
        expect(existing.points).toEqual([{ step: 4, value: 0.3 }]);
        const other = songLaneFor(song, track, 'volume', 0.5);
        const pan = songLaneFor(song, master, 'pan', 0.5);
        expect(other.lane).not.toBe(existing);
        expect(pan.lane).not.toBe(existing);
        expect(song.automation).toHaveLength(3);
        expect(songLaneFor(song, { kind: 'track', containerId: 'c1', trackId: 't1' }, 'volume', 0).lane).toBe(other.lane);
    });

    it('does not share the caller target object', () => {
        const song = new Song();
        const target = { kind: 'container' as const, containerId: 'c1' };
        const { lane } = songLaneFor(song, target, 'pan', 0.5);
        target.containerId = 'other';
        expect(lane.target).toEqual(bus);
    });
});

describe('recording a sweep into a song lane', () => {
    /** A controller swept 0 → 1 over song steps `from..to`, `perStep` messages a step, thinned and written like the recorder does. */
    const record = (points: AutomationPoint[], from: number, to: number, perStep: number, state: PlayState, own = new WeakSet<AutomationPoint>()) => {
        const thinner = new ControllerThinner<{ position: number; value: number }>();
        let last: number | null = null;
        const count = Math.round((to - from) * perStep);
        const write = (at: { position: number; value: number }) => {
            const point = { step: at.position, value: at.value };
            writeRecordedPoint(points, point, last, (p) => own.has(p), songWrap(state));
            own.add(point);
            last = at.position;
        };
        for (let i = 0; i <= count; i++) {
            const step = from + i / perStep;
            const at = { position: songPosition(step, state)!, value: i / count };
            if (thinner.offer(step, at.value, at)) {
                write(at);
            }
        }
        const pending = thinner.flush();
        if (pending) {
            write(pending);
        }
        return own;
    };

    it('thins the points and puts them at the song steps heard', () => {
        const state = songState();
        const song = state.song as Song;
        const { lane } = songLaneFor(song, master, 'volume', 0.5);
        record(lane.points, 2, 8, 32, state);
        const recorded = lane.points.slice(1);
        expect(recorded.length).toBeGreaterThan(10);
        expect(recorded.length).toBeLessThan(6 * 32);
        const perStep = new Map<number, number>();
        for (const point of recorded) {
            perStep.set(Math.floor(point.step), (perStep.get(Math.floor(point.step)) ?? 0) + 1);
        }
        expect(Math.max(...perStep.values())).toBeLessThanOrEqual(CC_MAX_PER_STEP);
        expect(recorded[0]!.step).toBeCloseTo(2, 9);
        expect(recorded[recorded.length - 1]!.step).toBeCloseTo(8, 9);
        expect(recorded[recorded.length - 1]!.value).toBeCloseTo(1, 9);
        // Each point where the sweep was when heard: value = (step - 2) / 6.
        for (const point of recorded) {
            expect(point.value).toBeCloseTo((point.step - 2) / 6, 2);
        }
        expect(recorded.some((point) => point.step % 1 !== 0)).toBe(true);
    });

    it('a gesture writes over the old curve it passes, also across the loop region end, and nothing outside it', () => {
        const state = songState({ start: 8, end: 16 });
        const points: AutomationPoint[] = [
            { step: 2, value: 0.9 },
            { step: 9, value: 0.9 },
            { step: 12, value: 0.9 },
            { step: 15.5, value: 0.9 },
            { step: 20, value: 0.9 },
        ];
        // Running steps 14..18 play song steps 14..16, then 8..10.
        record(points, 14, 18, 16, state);
        const old = points.filter((point) => point.value === 0.9).map((point) => point.step);
        // 15.5 and 9 were passed over; 12 (between 10 and 14, not passed), 2 (before the region) and 20 (after it) stay.
        expect(old).toEqual([2, 12, 20]);
        expect(inStretch(9, 15.9, 8.2, { start: 8, end: 16 })).toBe(false);
        expect(inStretch(8.1, 15.9, 8.2, { start: 8, end: 16 })).toBe(true);
        expect(inStretch(20, 15.9, 8.2, { start: 8, end: 16 })).toBe(false);
        expect(inStretch(20, 15.9, 8.2)).toBe(true);
    });
});

describe('holds around a gesture in a song lane', () => {
    interface At {
        position: number;
        value: number;
        step: number;
    }
    /**
     * Sweeps a controller over running steps `from..to` (`perStep` messages a step, values from `value(i/count)`) into a
     * lane the way the recorder does: thinned, the hold before a gesture counted in its step, the resting value in a full
     * step taking the last point's place, and the gesture finished at the end.
     */
    const sweep = (writer: LaneWriter, state: PlayState, from: number, to: number, perStep: number, value: (t: number) => number) => {
        const thinner = new ControllerThinner<At>();
        let last: At | null = null;
        let lastPoint: AutomationPoint | null = null;
        const write = (at: At) => {
            const point = { step: at.position, value: at.value };
            for (const added of writer.write(point, last ? last.position : null, songWrap(state))) {
                if (Math.floor(added.step) === Math.floor(point.step)) {
                    thinner.reserve();
                }
            }
            last = at;
            lastPoint = point;
        };
        const count = Math.round((to - from) * perStep);
        for (let i = 0; i <= count; i++) {
            const step = from + i / perStep;
            const at = { position: songPosition(step, state)!, value: value(i / count), step };
            if (thinner.offer(step, at.value, at)) {
                write(at);
            }
        }
        const full = thinner.isFull;
        const pending = thinner.flush();
        if (pending) {
            if (full && lastPoint && Math.floor(last!.step) === Math.floor(pending.step)) {
                writer.points.splice(writer.points.indexOf(lastPoint), 1);
            }
            write(pending);
        }
        return writer.finish();
    };
    /** An existing master volume lane: 0.3 at step 2, up to 0.9 at 12, down to 0.1 at 24 (straight segments). */
    const existing = () => {
        const song = new Song();
        song.addClip(song.lanes[0]!.id, 'c1', 16, 32);
        const lane = song.addAutomation(master, 'volume');
        lane.points.push({ step: 2, value: 0.3 }, { step: 12, value: 0.9 }, { step: 24, value: 0.1 });
        const old = lane.points.map((point) => ({ ...point }));
        return { song, lane, old: (step: number) => valueAt(old, step)! };
    };

    it('keeps an existing lane as it was right up to the gesture, and after it', () => {
        const { song, lane, old } = existing();
        const state: PlayState = { mode: 'song', currentContainerId: 'c1', song, songLength: song.length, loop: null };
        const take = new TakePoints();
        const after = sweep(new LaneWriter(lane.points, take), state, 6.3, 14.6, 32, (t) => 1 - t)!;
        const recorded = lane.points.filter(take.isOwn);
        expect(recorded[0]!.step).toBeCloseTo(6.3, 9);
        const holds = lane.points.filter(take.isHold);
        expect(holds).toHaveLength(2);
        expect(holds[0]!.step).toBeCloseTo(6.3 - HOLD_GAP, 9);
        expect(holds[0]!.shape).toBe('hold');
        expect(after.step).toBeCloseTo(recorded[recorded.length - 1]!.step + HOLD_GAP, 9);
        for (const step of [0, 2, 4, 6, 6.29]) {
            expect(valueAt(lane.points, step), `before, step ${step}`).toBeCloseTo(old(step), 9);
        }
        for (const step of [14.62, 16, 20, 24, 30]) {
            expect(valueAt(lane.points, step), `after, step ${step}`).toBeCloseTo(old(step), 9);
        }
        // The old point at 12 was written over.
        expect(lane.points.some((point) => point.step === 12)).toBe(false);
        expect(valueAt(lane.points, 6.3)).toBeCloseTo(1, 9);
    });

    it('a new lane (holding its start value) needs no hold before, and keeps the recorded end value after', () => {
        const song = new Song();
        const { lane, start } = songLaneFor(song, bus, 'volume', 0.8);
        const take = new TakePoints();
        take.addOwn(start!);
        sweep(new LaneWriter(lane.points, take), songState(), 4, 6, 16, (t) => t);
        expect(lane.points.filter(take.isHold)).toHaveLength(0);
        expect(valueAt(lane.points, 3.99)).toBe(0.8);
        expect(valueAt(lane.points, 40)).toBe(1);
    });

    it('wraps at the loop region end: the hold before is on the first pass, the hold after the wrapped end, nothing outside is touched', () => {
        const { song, lane, old } = existing();
        const state: PlayState = { mode: 'song', currentContainerId: 'c1', song, songLength: song.length, loop: { start: 8, end: 16 } };
        const take = new TakePoints();
        // Running steps 13..19 play song steps 13..16, then 8..11.
        const after = sweep(new LaneWriter(lane.points, take), state, 13, 19, 16, (t) => t)!;
        // Before the gesture (13), after its wrapped end (11), before the region (8) and from the region's end (16) on.
        const holds = lane.points.filter(take.isHold);
        expect(holds.map((point) => point.step)).toEqual([8 - HOLD_GAP, 11 + HOLD_GAP, 13 - HOLD_GAP, 16]);
        expect(holds[1]).toBe(after);
        // The old point at 12 lies between the wrapped end (11) and the start (13): kept, as are 2 and 24 outside.
        expect(lane.points.filter((point) => !take.isTake(point)).map((point) => point.step)).toEqual([2, 12, 24]);
        for (const step of [0, 4, 7, 8 - HOLD_GAP, 11.01, 12, 12.5, 12.99, 16, 16.5, 20, 24, 30]) {
            expect(valueAt(lane.points, step), `step ${step}`).toBeCloseTo(old(step), 9);
        }
        // The region starts where the gesture was when it wrapped (not the old curve, not a ramp from step 2).
        const start = lane.points.find((point) => point.step === 8)!;
        expect(take.isOwn(start)).toBe(true);
        const beforeWrap = lane.points.filter((point) => take.isOwn(point) && point.step < 16);
        const lastBeforeWrap = beforeWrap[beforeWrap.length - 1]!;
        expect(start.value).toBe(lastBeforeWrap.value);
        expect(start.value).toBeGreaterThan(0.45);
    });

    it('holds never make a step hold more than 16 of the take points', () => {
        const { song, lane } = existing();
        const state: PlayState = { mode: 'song', currentContainerId: 'c1', song, songLength: song.length, loop: null };
        const take = new TakePoints();
        // 64 messages a step: the thinner fills every step it passes.
        sweep(new LaneWriter(lane.points, take), state, 5.5, 7.8, 64, (t) => t);
        const perStep = new Map<number, number>();
        for (const point of lane.points.filter(take.isTake)) {
            perStep.set(Math.floor(point.step), (perStep.get(Math.floor(point.step)) ?? 0) + 1);
        }
        expect(perStep.get(5)).toBe(CC_MAX_PER_STEP);
        expect(perStep.get(7)).toBe(CC_MAX_PER_STEP);
        expect(Math.max(...perStep.values())).toBeLessThanOrEqual(CC_MAX_PER_STEP);
        expect(lane.points.filter(take.isHold)).toHaveLength(2);
        // The controller's resting value is the last recorded point.
        const recorded = lane.points.filter(take.isOwn);
        expect(recorded[recorded.length - 1]!.value).toBeCloseTo(1, 9);
    });

    it('replace: no hold in a song step the take cleared', () => {
        const { song, lane } = existing();
        const state: PlayState = { mode: 'song', currentContainerId: 'c1', song, songLength: song.length, loop: null };
        const pass = new SongReplacePass();
        const take = new TakePoints();
        for (const step of [5, 6, 7]) {
            pass.claim(step);
            clearLaneStep(lane.points, step, take.isOwn);
        }
        expect(pass.has(6.5)).toBe(true);
        expect(pass.has(8)).toBe(false);
        // Before (6.3) is cleared: no hold; after (8.5+) is not yet: the old curve goes on from there.
        sweep(new LaneWriter(lane.points, take, (position) => pass.has(position)), state, 6.3, 8.5, 16, (t) => t);
        const holds = lane.points.filter(take.isHold);
        expect(holds).toHaveLength(1);
        const recorded = lane.points.filter(take.isOwn);
        expect(holds[0]!.step).toBeCloseTo(recorded[recorded.length - 1]!.step + HOLD_GAP, 9);
    });
});

describe('the resting value in a full step', () => {
    it('says when the step of a dropped value is full, so the value takes the place of its last point', () => {
        const thinner = new ControllerThinner<number>();
        for (let i = 0; i < CC_MAX_PER_STEP; i++) {
            expect(thinner.isFull).toBe(false);
            expect(thinner.offer(3 + i / 32, i / 20, i)).toBe(true);
        }
        expect(thinner.offer(3.9, 0.99, 99)).toBe(false);
        expect(thinner.isFull).toBe(true);
        expect(thinner.flush()).toBe(99);
        expect(thinner.offer(4, 0.5, 100)).toBe(true);
        expect(thinner.isFull).toBe(false);
    });
});

describe('replace in song lanes', () => {
    it('clears each song step once, the first time the take plays it; a late lane loses what was passed', () => {
        const pass = new SongReplacePass();
        expect(pass.claim(8)).toBe(true);
        expect(pass.claim(8.5)).toBe(false);
        expect(pass.claim(9)).toBe(true);
        expect(pass.clearedSteps()).toEqual([8, 9]);
        const song = new Song();
        const lane = song.addAutomation(bus, 'pan');
        const own = new WeakSet<AutomationPoint>();
        const mine = { step: 8.25, value: 0.1 };
        own.add(mine);
        lane.points.push({ step: 7.5, value: 0.9 }, { step: 8, value: 0.9 }, mine, { step: 9.75, value: 0.9 }, { step: 10, value: 0.9 });
        for (const step of pass.clearedSteps()) {
            clearLaneStep(lane.points, step, (point) => own.has(point));
        }
        expect(lane.points.map((point) => point.step)).toEqual([7.5, 8.25, 10]);
    });
});
