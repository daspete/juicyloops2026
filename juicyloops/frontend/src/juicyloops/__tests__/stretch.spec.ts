import { describe, expect, it } from 'vitest';
import { semitoneRatio, timeStretch } from '../stretch';

const RATE = 8000;

const sine = (frequency: number, seconds: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.sin((2 * Math.PI * frequency * i) / RATE));

/** Frequency of a steady tone, from how often it crosses zero upwards. */
const frequencyOf = (signal: Float32Array, from: number, to: number): number => {
    let crossings = 0;
    for (let i = from + 1; i < to; i++) {
        if (signal[i - 1]! < 0 && signal[i]! >= 0) {
            crossings++;
        }
    }
    return (crossings * RATE) / (to - from);
};

const rms = (signal: Float32Array, from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i < to; i++) {
        sum += signal[i]! ** 2;
    }
    return Math.sqrt(sum / (to - from));
};

describe('time stretch', () => {
    it('changes the length by the factor and keeps the pitch and the level', () => {
        const input = sine(220, 1);
        for (const factor of [0.5, 1.5, 2]) {
            const [output] = timeStretch([input], RATE, factor);
            expect(output!.length).toBe(Math.round(input.length * factor));
            const middle = [Math.round(output!.length * 0.2), Math.round(output!.length * 0.8)] as const;
            expect(frequencyOf(output!, ...middle)).toBeCloseTo(220, -1);
            expect(rms(output!, ...middle)).toBeCloseTo(Math.SQRT1_2, 1);
        }
    });

    it('stretches every channel the same way and leaves the input alone', () => {
        const left = sine(220, 0.5);
        const right = left.map((value) => -value);
        const copy = left.slice();
        const [a, b] = timeStretch([left, right], RATE, 1.3);
        expect(a!.length).toBe(b!.length);
        expect(a!.every((value, i) => Math.abs(value + b![i]!) < 1e-6)).toBe(true);
        expect(left).toEqual(copy);
    });

    it('returns copies when there is nothing to stretch', () => {
        const input = sine(220, 0.1);
        const [output] = timeStretch([input], RATE, 1);
        expect(output).toEqual(input);
        expect(output).not.toBe(input);
    });

    it('gives the playback rate of a semitone shift', () => {
        expect(semitoneRatio(12)).toBeCloseTo(2);
        expect(semitoneRatio(-12)).toBeCloseTo(0.5);
        expect(semitoneRatio(0)).toBe(1);
    });
});
