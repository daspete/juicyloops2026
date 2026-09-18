import { describe, expect, it } from 'vitest';
import {
    createSongLane,
    formatValue,
    movePoint,
    removePoint,
    sameTarget,
    setPoint,
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
