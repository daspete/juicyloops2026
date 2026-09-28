import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { answerSampleRequest } from '../dsp/sampleProtocol';
import { instantiateSignalsmith, type Signalsmith } from '../dsp/signalsmith';
import { timeStretch } from '../stretch';

const RATE = 48000;

const sine = (frequency: number, seconds: number, amplitude = 0.5) =>
    Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE));

/** Frequency from the rising zero crossings over the middle 80 %. */
const frequencyOf = (signal: Float32Array) => {
    const crossings: number[] = [];
    for (let i = Math.floor(signal.length * 0.1) + 1; i < signal.length * 0.9; i++) {
        const a = signal[i - 1]!;
        const b = signal[i]!;
        if (a < 0 && b >= 0) {
            crossings.push(i - b / (b - a));
        }
    }
    return (RATE * (crossings.length - 1)) / (crossings[crossings.length - 1]! - crossings[0]!);
};

const rms = (signal: Float32Array) => Math.sqrt(signal.reduce((sum, v) => sum + v * v, 0) / signal.length);

/* The committed module, read from disk: the same bytes the worker fetches. (Not `new URL(…, import.meta.url)`: Vite would turn that into an asset URL.) */
let engine: Signalsmith;
beforeAll(async () => {
    engine = await instantiateSignalsmith(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dsp/wasm/stretch.wasm')));
});

describe('Signalsmith Stretch', () => {
    it.each([2, 0.5, 1.5, 1 / 1.4983])('stretches by %f keeping the pitch, the level and the length rule of WSOLA', (factor) => {
        const left = sine(440, 1);
        const right = sine(440, 1, 0.25);
        const out = engine.stretch([left, right], RATE, factor);
        expect(out).toHaveLength(2);
        expect(out[0]!.length).toBe(Math.round(left.length * factor));
        expect(out[0]!.length).toBe(timeStretch([left], RATE, factor)[0]!.length);
        expect(frequencyOf(out[0]!)).toBeCloseTo(440, 0);
        expect(rms(out[0]!) / rms(left)).toBeGreaterThan(0.95);
        expect(rms(out[0]!) / rms(left)).toBeLessThan(1.05);
        expect(rms(out[1]!) / rms(out[0]!)).toBeCloseTo(0.5, 1);
    });

    it('leaves its input alone and returns copies for a factor of 1', () => {
        const input = sine(220, 0.2);
        const before = input.slice();
        const same = engine.stretch([input], RATE, 1);
        expect(same[0]).toEqual(input);
        expect(same[0]).not.toBe(input);
        engine.stretch([input], RATE, 1.7);
        expect(input).toEqual(before);
    });

    it('stretches a one-shot shorter than its analysis window', () => {
        const hit = sine(1000, 0.03);
        const out = engine.stretch([hit], RATE, 2);
        expect(out[0]!.length).toBe(hit.length * 2);
        expect(out[0]!.every(Number.isFinite)).toBe(true);
        expect(rms(out[0]!)).toBeGreaterThan(0.1);
    });

    it('gives the same output for the same input', () => {
        const a = engine.stretch([sine(330, 0.5)], RATE, 1.3)[0]!;
        const b = engine.stretch([sine(330, 0.5)], RATE, 1.3)[0]!;
        expect(a).toEqual(b);
    });

    it('answers stretch requests through the protocol, and falls back to WSOLA when the engine throws', async () => {
        const request = () => ({ kind: 'stretch' as const, jobId: 7, channels: [sine(440, 0.5)], sampleRate: RATE, factor: 1.25 });

        const signalsmith = await answerSampleRequest(request(), (channels, rate, factor) => engine.stretch(channels, rate, factor));
        expect(signalsmith.kind).toBe('stretch');

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const broken = await answerSampleRequest(request(), () => {
            throw new Error('out of memory');
        });
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        const wsola = timeStretch(request().channels, RATE, 1.25);
        expect(broken).toEqual({ kind: 'stretch', jobId: 7, channels: wsola });
    });
});
