import { describe, expect, it } from 'vitest';
import {
    createSongLane,
    formatValue,
    movePoint,
    removePoint,
    sameTarget,
    segmentProgress,
    setPoint,
    setSegment,
    toNormalized,
    toValue,
    TrackAutomation,
    valueAt,
    type AutomationParam,
} from '../automation';
import { Song } from '../song';

const linear: AutomationParam = { key: 'volume', label: 'Volume', group: 'Mix', min: -40, max: 6, step: 0.1 };
const log: AutomationParam = { key: 'fx.delay.delayTime', label: 'Time', group: 'Delay', min: 0.01, max: 1, step: 0.01, curve: 'log', format: (v) => `${v}s` };

describe('parameter ranges', () => {
    it('maps positions to values and back, linearly and logarithmically', () => {
        expect(toValue(linear, 0)).toBe(-40);
        expect(toValue(linear, 1)).toBe(6);
        expect(toValue(linear, 0.5)).toBe(-17);
        expect(toNormalized(linear, -17)).toBeCloseTo(0.5);

        expect(toValue(log, 0)).toBe(0.01);
        expect(toValue(log, 1)).toBe(1);
        expect(toValue(log, 0.5)).toBe(0.1);
        expect(toNormalized(log, 0.1)).toBeCloseTo(0.5);
    });

    it('clamps and snaps to the parameter step', () => {
        expect(toValue(linear, 2)).toBe(6);
        expect(toValue(linear, -1)).toBe(-40);
        expect(toNormalized(linear, 100)).toBe(1);
        expect(toValue(linear, 0.123456)).toBe(-34.3);
        expect(formatValue(log, 1)).toBe('1s');
        expect(formatValue(linear, 1)).toBe('6');
    });
});

describe('TrackAutomation', () => {
    it('keeps one lane per parameter, inside the pattern', () => {
        const automation = new TrackAutomation(8);
        const lane = automation.add('volume', 0.25);
        expect(lane.points).toEqual([{ step: 0, value: 0.25 }]);
        expect(valueAt(lane.points, 5)).toBe(0.25);
        expect(automation.add('volume', 0.9)).toBe(lane);
        expect(automation.lanes).toHaveLength(1);

        setPoint(lane, 7, 1);
        setPoint(lane, 11, 0);
        automation.resize(12);
        expect(lane.points.map((point) => point.step)).toEqual([0, 7, 11]);

        // Shrinking drops what is past the end; the first dropped point lands on the last step so the curve keeps going there.
        automation.resize(4);
        expect(lane.points).toEqual([
            { step: 0, value: 0.25 },
            { step: 3, value: 1 },
        ]);

        automation.remove(lane.id);
        expect(automation.lanes).toHaveLength(0);
    });

    it('copies lanes from another track and fits them to its own length', () => {
        const source = new TrackAutomation(16);
        setPoint(source.add('pan', 0.5), 12, 0);
        const copy = new TrackAutomation(8);
        copy.copyFrom(source);
        expect(copy.lanes[0]!.id).not.toBe(source.lanes[0]!.id);
        expect(copy.lanes[0]!.points).toEqual([
            { step: 0, value: 0.5 },
            { step: 7, value: 0 },
        ]);
    });
});

describe('song automation lanes', () => {
    it('interpolates between points and holds the ends', () => {
        const lane = createSongLane({ kind: 'master' }, 'volume');
        expect(valueAt(lane.points, 10)).toBeNull();

        setPoint(lane, 16, 0);
        setPoint(lane, 48, 1);
        setPoint(lane, 32, 0.5);
        expect(lane.points.map((point) => point.step)).toEqual([16, 32, 48]);
        expect(valueAt(lane.points, 0)).toBe(0);
        expect(valueAt(lane.points, 24)).toBe(0.25);
        expect(valueAt(lane.points, 40)).toBe(0.75);
        expect(valueAt(lane.points, 100)).toBe(1);

        expect(setPoint(lane, 32, 0.9)).toBe(1);
        expect(lane.points).toHaveLength(3);
        expect(valueAt(lane.points, 32)).toBe(0.9);
    });

    it('moves points without crossing their neighbours and removes them', () => {
        const lane = createSongLane({ kind: 'master' }, 'volume');
        setPoint(lane, 0, 0);
        setPoint(lane, 16, 0.5);
        setPoint(lane, 32, 1);

        movePoint(lane, 1, 40, 2);
        expect(lane.points[1]).toEqual({ step: 31, value: 1 });
        movePoint(lane, 1, -5, -1);
        expect(lane.points[1]).toEqual({ step: 1, value: 0 });

        removePoint(lane, 1);
        expect(lane.points.map((point) => point.step)).toEqual([0, 32]);
    });

    it('lives in the song and goes with its container or track', () => {
        const song = new Song();
        song.addAutomation({ kind: 'master' }, 'volume');
        song.addAutomation({ kind: 'container', containerId: 'c1' }, 'pan');
        const trackLane = song.addAutomation({ kind: 'track', containerId: 'c1', trackId: 't1' }, 'volume');
        song.addAutomation({ kind: 'track', containerId: 'c2', trackId: 't2' }, 'volume');

        expect(sameTarget(trackLane.target, { kind: 'track', containerId: 'c1', trackId: 't1' })).toBe(true);
        expect(sameTarget(trackLane.target, { kind: 'container', containerId: 'c1' })).toBe(false);

        song.removeTrack('t2');
        expect(song.automation).toHaveLength(3);
        song.removeContainer('c1');
        expect(song.automation.map((lane) => lane.target.kind)).toEqual(['master']);
        song.removeAutomation(song.automation[0]!.id);
        expect(song.automation).toHaveLength(0);
    });
});

describe('curve shapes', () => {
    const rising = () => ({ points: [{ step: 0, value: 0 }, { step: 8, value: 1 }] as { step: number; value: number; shape?: 'curve' | 's-curve' | 'hold'; tension?: number }[] });

    it('is a straight line without tension', () => {
        expect(segmentProgress(0.25)).toBe(0.25);
        expect(segmentProgress(0.25, 's-curve', 0)).toBe(0.25);
        expect(valueAt(rising().points, 4)).toBe(0.5);
    });

    it('bends a curve towards either end and keeps its ends', () => {
        const late = segmentProgress(0.5, 'curve', 1);
        const early = segmentProgress(0.5, 'curve', -1);
        expect(late).toBeCloseTo(1 / 256);
        expect(early).toBeCloseTo(1 - 1 / 256);
        for (const tension of [-1, -0.4, 0.4, 1]) {
            expect(segmentProgress(0, 'curve', tension)).toBe(0);
            expect(segmentProgress(1, 'curve', tension)).toBe(1);
        }
    });

    it('shapes both ends of an S-curve, which always passes the middle at half way', () => {
        expect(segmentProgress(0.5, 's-curve', 0.8)).toBeCloseTo(0.5);
        expect(segmentProgress(0.5, 's-curve', -0.8)).toBeCloseTo(0.5);
        // Easing in and out: slow at both ends.
        expect(segmentProgress(0.1, 's-curve', 1)).toBeLessThan(0.1);
        expect(segmentProgress(0.9, 's-curve', 1)).toBeGreaterThan(0.9);
        // The other way: fast at both ends.
        expect(segmentProgress(0.1, 's-curve', -1)).toBeGreaterThan(0.1);
        expect(segmentProgress(0.9, 's-curve', -1)).toBeLessThan(0.9);
    });

    it('holds the value until the next point', () => {
        const curve = rising();
        setSegment(curve, 0, 'hold', 0.5);
        expect(curve.points[0]).toEqual({ step: 0, value: 0, shape: 'hold' });
        expect(valueAt(curve.points, 7)).toBe(0);
        expect(valueAt(curve.points, 8)).toBe(1);
    });

    it('drives the value between points with the segment start point', () => {
        const curve = rising();
        setSegment(curve, 0, 'curve', 1);
        expect(valueAt(curve.points, 4)).toBeCloseTo(1 / 256);
        setSegment(curve, 0, 'curve', 0);
        expect(curve.points[0]).toEqual({ step: 0, value: 0 });
    });

    it('keeps the shape on both halves when a point splits a shaped segment', () => {
        const curve = rising();
        setSegment(curve, 0, 's-curve', -0.5);
        setPoint(curve, 4, 0.3);
        expect(curve.points[1]).toMatchObject({ step: 4, value: 0.3, shape: 's-curve', tension: -0.5 });
        // A point after the last one starts nothing, so it gets no shape.
        setPoint(curve, 12, 0.2);
        expect(curve.points[3]).toEqual({ step: 12, value: 0.2 });
    });

    it('survives serialization of a step lane', () => {
        const automation = new TrackAutomation(16);
        const lane = automation.add('volume', 0);
        setPoint(lane, 8, 1);
        setSegment(lane, 0, 's-curve', 0.6);
        const copy = new TrackAutomation(16);
        copy.restore(automation.serialize());
        expect(copy.lanes[0]!.points[0]).toEqual({ step: 0, value: 0, shape: 's-curve', tension: 0.6 });
    });
});
