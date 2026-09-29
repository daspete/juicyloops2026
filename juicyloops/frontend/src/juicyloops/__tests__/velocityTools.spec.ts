import { describe, expect, it } from 'vitest';
import {
    accentEvery,
    clampVelocity,
    humanize,
    rampNotes,
    rampOverTime,
    rampValue,
    randomize,
    scaleAroundAverage,
    setAll,
    shiftFrom,
    type VelocityChange,
    type VelocityItem,
    type VelocityNote,
} from '../notes/velocityTools';

const notes = (...velocities: number[]): VelocityNote[] => velocities.map((velocity, index) => ({ id: `n${index}`, start: index, velocity }));
const items = (...velocities: number[]): VelocityItem[] => velocities.map((velocity, index) => ({ id: `n${index}`, at: index * 10, velocity }));
const asMap = (changes: VelocityChange[]) => Object.fromEntries(changes.map((change) => [change.id, change.velocity]));

describe('velocity tools', () => {
    it('keeps velocities to whole percent inside 0..1', () => {
        expect(clampVelocity(0.456)).toBe(0.46);
        expect(clampVelocity(1.3)).toBe(1);
        expect(clampVelocity(-0.2)).toBe(0);
    });

    it('ramps straight between two points and holds outside them', () => {
        const a = { at: 0, value: 0.2 };
        const b = { at: 10, value: 1 };
        expect(rampValue(a, b, 5)).toBeCloseTo(0.6);
        expect(rampValue(a, b, -5)).toBeCloseTo(0.2);
        expect(rampValue(a, b, 20)).toBeCloseTo(1);
        // Drawn right to left, the same straight line.
        expect(rampValue(b, a, 5)).toBeCloseTo(0.6);
        // No width: the later point wins.
        expect(rampValue({ at: 3, value: 0.1 }, { at: 3, value: 0.9 }, 3)).toBe(0.9);
    });

    it('bends a ramp like an automation segment', () => {
        const a = { at: 0, value: 0 };
        const b = { at: 10, value: 1 };
        // Positive tension holds back at the start: below the straight line in the middle of a rising ramp.
        expect(rampValue(a, b, 5, 'curve', 0.5)).toBeLessThan(0.5);
        expect(rampValue(a, b, 5, 'curve', -0.5)).toBeGreaterThan(0.5);
        // An S-curve passes the middle at half height whatever its tension.
        expect(rampValue(a, b, 5, 's-curve', 0.8)).toBeCloseTo(0.5);
        expect(rampValue(a, b, 2, 's-curve', 0.8)).toBeLessThan(0.2);
        // Drawn the other way round, a curve keeps its look along the drag direction (mirrored in position).
        expect(rampValue(b, a, 5, 'curve', 0.5)).toBeGreaterThan(0.5);
    });

    it('sets every note between the ends of a line, and only those', () => {
        const changes = asMap(rampNotes(items(0.5, 0.5, 0.5, 0.5, 0.5), { at: 10, value: 0 }, { at: 30, value: 1 }));
        expect(changes).toEqual({ n1: 0, n3: 1 });
        // n2 sits in the middle and already has 0.5, so it is not in the list.
        expect(asMap(rampNotes(items(0.5, 0.5, 0.2), { at: 10, value: 0 }, { at: 30, value: 1 }))).toEqual({ n1: 0, n2: 0.5 });
    });

    it('widens a line by the reach, so a stem right beside an end is caught', () => {
        const changes = asMap(rampNotes(items(0.5, 0.5, 0.5), { at: 12, value: 1 }, { at: 12, value: 1 }, { reach: 4 }));
        expect(changes).toEqual({ n1: 1 });
    });

    it('sets all, and leaves notes that already have the value out', () => {
        expect(asMap(setAll(notes(0.2, 0.75, 1), 0.75))).toEqual({ n0: 0.75, n2: 0.75 });
    });

    it('humanizes within the amount', () => {
        let turn = 0;
        const random = () => [0, 1, 0.5][turn++ % 3]!;
        expect(asMap(humanize(notes(0.5, 0.5, 0.5), 0.1, random))).toEqual({ n0: 0.4, n1: 0.6 });
    });

    it('randomizes into a range', () => {
        const values = randomize(notes(0, 0, 0, 0), 0.4, 0.8, () => 0.5).map((change) => change.velocity);
        expect(values).toEqual([0.6, 0.6, 0.6, 0.6]);
    });

    it('scales around the average', () => {
        expect(asMap(scaleAroundAverage(notes(0.4, 0.6), 2))).toEqual({ n0: 0.3, n1: 0.7 });
        expect(asMap(scaleAroundAverage(notes(0.4, 0.6), 0))).toEqual({ n0: 0.5, n1: 0.5 });
        expect(scaleAroundAverage([], 2)).toEqual([]);
    });

    it('ramps over time, chords sharing a value', () => {
        const chord: VelocityNote[] = [...notes(1, 1, 1), { id: 'c', start: 2, velocity: 1 }];
        expect(asMap(rampOverTime(chord, 0.2, 1))).toEqual({ n0: 0.2, n1: 0.6 });
        expect(asMap(rampOverTime(notes(1), 0.3, 0.9))).toEqual({ n0: 0.9 });
    });

    it('accents every nth step', () => {
        const pattern: VelocityNote[] = [0, 1, 2, 4, 4.5, 8].map((start, index) => ({ id: `n${index}`, start, velocity: 0.5 }));
        expect(asMap(accentEvery(pattern, 4))).toEqual({ n0: 1, n1: 0.7, n2: 0.7, n3: 1, n4: 1, n5: 1 });
    });

    it('shifts from where a drag began, clamped', () => {
        expect(shiftFrom([{ id: 'a', velocity: 0.5 }, { id: 'b', velocity: 0.9 }], 0.2)).toEqual([
            { id: 'a', velocity: 0.7 },
            { id: 'b', velocity: 1 },
        ]);
    });
});
