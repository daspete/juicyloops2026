import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { noteFrequency } from '../dsp/SynthVoices';
import { SYNTH_ABI, SYNTH_PROCESSOR, SynthEvents, SynthParam, WAVEFORMS, type SynthMessage } from '../dsp/synthProtocol';
import { defaultPatch, ENGINE_KIND, PatchId } from '../synths/params';
import { patchEntries } from '../tracks/synthEngine';

/** A port that records what it is sent. */
const stubPort = () => {
    const sent: SynthMessage[] = [];
    return { sent, postMessage: (message: SynthMessage) => sent.push(message) };
};

/** Note lengths at 120 bpm, as the transport would convert them. */
const seconds = (duration: string | number) => (typeof duration === 'number' ? duration : ({ '16n': 0.125, '4n': 0.5, '1n': 2 } as Record<string, number>)[duration]!);

describe('SynthVoices event conversion', () => {
    it('converts notes with Tone and caches them', () => {
        expect(noteFrequency('A4')).toBeCloseTo(440, 6);
        expect(noteFrequency('C5')).toBeCloseTo(523.2511, 3);
        expect(noteFrequency('E5')).toBeCloseTo(659.2551, 3);
        expect(noteFrequency(123)).toBe(123);
        expect(noteFrequency('A4')).toBe(noteFrequency('A4'));
    });

    it('posts a note with its frequency, length in seconds, velocity and time', () => {
        const events = new SynthEvents({ frequency: noteFrequency, seconds });
        const port = stubPort();
        events.attach(port);
        expect(events.note('A4', '16n', 3.25, 0.5)).toBe(0.125);
        expect(port.sent).toEqual([{ type: 'note', time: 3.25, id: 0, frequency: expect.closeTo(440, 6), velocity: 0.5, duration: 0.125 }]);
    });

    it('posts live notes held until their note-off', () => {
        const events = new SynthEvents({ frequency: noteFrequency, seconds });
        const port = stubPort();
        events.attach(port);
        events.noteOn(3, 'A4', 1.5, 0.8);
        events.noteOff(3, 2);
        events.param('bend', -1.5, 2.5);
        expect(port.sent).toEqual([
            { type: 'note', time: 1.5, id: 3, frequency: expect.closeTo(440, 6), velocity: 0.8, duration: -1 },
            { type: 'noteOff', time: 2, id: 3 },
            { type: 'param', time: 2.5, id: SynthParam.bend, value: -1.5 },
        ]);
    });

    it('posts parameters by engine id, timed or right away, and the mode', () => {
        const events = new SynthEvents({ frequency: noteFrequency, seconds });
        const port = stubPort();
        events.attach(port);
        events.param('release', 0.4, 7.5);
        events.param('waveform', WAVEFORMS.sawtooth);
        events.mode(false);
        expect(port.sent).toEqual([
            { type: 'param', time: 7.5, id: SynthParam.release, value: 0.4 },
            { type: 'param', time: 0, id: SynthParam.waveform, value: 3 },
            { type: 'mode', mono: false },
        ]);
    });

    it('holds everything until the node exists, then sends it in order', () => {
        const events = new SynthEvents({ frequency: noteFrequency, seconds });
        events.mode(true);
        events.param('sustain', 0.8);
        events.note('C5', '4n', 1);
        const port = stubPort();
        events.attach(port);
        expect(port.sent.map((message) => message.type)).toEqual(['mode', 'param', 'note']);
        events.note('A4', 0.3, 2);
        expect(port.sent).toHaveLength(4);
    });

    it('tells the processor to stop on dispose and drops what was waiting', () => {
        const waiting = new SynthEvents({ frequency: noteFrequency, seconds });
        waiting.note('A4', '4n', 1);
        waiting.dispose();
        const events = new SynthEvents({ frequency: noteFrequency, seconds });
        const port = stubPort();
        events.attach(port);
        events.dispose();
        expect(port.sent).toEqual([{ type: 'dispose' }]);
        events.note('A4', '4n', 1);
        expect(port.sent).toHaveLength(1);
    });
});

/*
 * The processor itself, in Node: the committed `.wasm` read from disk, and the worklet scope's globals stubbed. The same
 * code runs in the AudioWorklet.
 */
describe('synth processor', () => {
    const RATE = 48000;
    const wasm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dsp/wasm/synth-worklet.wasm'));

    type Processor = { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
    let Processor: new (options: { processorOptions: { module: WebAssembly.Module; abi: number; kind?: number } }) => Processor & { port: { onmessage: ((event: { data: SynthMessage }) => void) | null } };
    let registeredAs = '';

    beforeAll(async () => {
        vi.stubGlobal('sampleRate', RATE);
        vi.stubGlobal('currentFrame', 0);
        vi.stubGlobal(
            'AudioWorkletProcessor',
            class {
                readonly port = { onmessage: null };
            },
        );
        vi.stubGlobal('registerProcessor', (name: string, processor: typeof Processor) => {
            registeredAs = name;
            Processor = processor;
        });
        await import('../dsp/synthProcessor');
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    const create = (kind = 0) => {
        const processor = new Processor({ processorOptions: { module: new WebAssembly.Module(wasm), abi: SYNTH_ABI, kind } });
        const send = (message: SynthMessage) => processor.port.onmessage!({ data: message });
        /** Renders `seconds` from `from` (context time) in 128-frame blocks, as the audio thread does: one channel, or two. */
        const renderChannels = (from: number, seconds: number, channels: number) => {
            const outs = Array.from({ length: channels }, () => new Float32Array(Math.round(seconds * RATE)));
            let alive = true;
            for (let offset = 0; offset < outs[0]!.length; offset += 128) {
                vi.stubGlobal('currentFrame', Math.round(from * RATE) + offset);
                const blocks = outs.map(() => new Float32Array(128).fill(NaN));
                alive = processor.process([], [blocks]);
                blocks.forEach((block, i) => outs[i]!.set(block.subarray(0, Math.min(128, outs[i]!.length - offset)), offset));
            }
            return { outs, alive };
        };
        const render = (from: number, seconds: number) => {
            const { outs, alive } = renderChannels(from, seconds, 1);
            return { out: outs[0]!, alive };
        };
        return { processor, send, render, renderChannels };
    };

    const pitch = (signal: Float32Array) => {
        const crossings: number[] = [];
        for (let i = 1; i < signal.length; i++) {
            if (signal[i - 1]! < 0 && signal[i]! >= 0) {
                crossings.push(i - signal[i]! / (signal[i]! - signal[i - 1]!));
            }
        }
        return (RATE * (crossings.length - 1)) / (crossings[crossings.length - 1]! - crossings[0]!);
    };
    const peak = (signal: Float32Array) => signal.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

    it('registers under the name the main thread asks for', () => {
        expect(registeredAs).toBe(SYNTH_PROCESSOR);
    });

    it('refuses a module that speaks another ABI', () => {
        expect(() => new Processor({ processorOptions: { module: new WebAssembly.Module(wasm), abi: SYNTH_ABI + 1 } })).toThrow(/ABI/);
    });

    it('is silent until told otherwise', () => {
        const { render } = create();
        const { out, alive } = render(0, 0.1);
        expect(alive).toBe(true);
        expect(peak(out)).toBe(0);
    });

    it('plays A4 at 440 Hz, starting on the frame of its time', () => {
        const { send, render } = create();
        send({ type: 'param', time: 0, id: SynthParam.sustain, value: 1 });
        send({ type: 'note', id: 0, time: 0.5, frequency: 440, velocity: 1, duration: 0.5 });
        const { out } = render(0, 1.5);
        const start = 0.5 * RATE;
        expect(peak(out.subarray(0, start + 1))).toBe(0);
        expect(Math.abs(out[start + 1]!)).toBeGreaterThan(0);
        // Attack 5 ms from silence: no click.
        expect(peak(out.subarray(start, start + 24))).toBeLessThan(0.11);
        expect(pitch(out.subarray(start + 2400, start + 20000))).toBeCloseTo(440, 1);
        expect(peak(out.subarray(start + 2400, start + 20000))).toBeCloseTo(1, 2);
        // Released at 1.0 s, a 1 s release: much quieter half a second later.
        expect(peak(out.subarray(1.45 * RATE))).toBeLessThan(0.05);
    });

    it('applies timed envelope changes on their frame', () => {
        const { send, render } = create();
        send({ type: 'param', time: 0, id: SynthParam.sustain, value: 1 });
        send({ type: 'note', id: 0, time: 0, frequency: 440, velocity: 1, duration: 2 });
        send({ type: 'param', time: 0.5, id: SynthParam.sustain, value: 0.25 });
        const { out } = render(0, 1);
        expect(peak(out.subarray(0.3 * RATE, 0.5 * RATE))).toBeCloseTo(1, 2);
        expect(peak(out.subarray(0.6 * RATE))).toBeCloseTo(0.25, 2);
    });

    it('cuts notes in mono mode and overlaps them otherwise', () => {
        const level = (mono: boolean) => {
            const { send, render } = create();
            send({ type: 'mode', mono });
            send({ type: 'param', time: 0, id: SynthParam.sustain, value: 1 });
            send({ type: 'note', id: 0, time: 0, frequency: 440, velocity: 1, duration: 2 });
            send({ type: 'note', id: 0, time: 0.25, frequency: 660, velocity: 1, duration: 2 });
            return peak(render(0, 1).out.subarray(0.5 * RATE));
        };
        expect(level(true)).toBeCloseTo(1, 2);
        expect(level(false)).toBeGreaterThan(1.5);
    });

    it('holds a live note until its note-off, and bends it', () => {
        const { send, render } = create();
        send({ type: 'param', time: 0, id: SynthParam.sustain, value: 1 });
        send({ type: 'param', time: 0, id: SynthParam.release, value: 0.01 });
        send({ type: 'note', id: 4, time: 0, frequency: 440, velocity: 1, duration: -1 });
        const held = render(0, 3).out;
        expect(peak(held.subarray(2.5 * RATE))).toBeCloseTo(1, 2);
        expect(pitch(held.subarray(RATE, 2 * RATE))).toBeCloseTo(440, 1);
        send({ type: 'param', time: 3, id: SynthParam.bend, value: 2 });
        const bent = render(3, 0.5).out;
        expect(pitch(bent.subarray(0.1 * RATE))).toBeCloseTo(440 * 2 ** (2 / 12), 0);
        send({ type: 'noteOff', id: 4, time: 3.5 });
        const released = render(3.5, 0.5).out;
        expect(peak(released.subarray(0.2 * RATE))).toBe(0);
    });

    /** A patch engine with its default patch, playing 220 Hz from 0.1 s for half a second; both sides rendered. */
    const playDefault = (model: 'analog' | 'wavetable' | 'fm') => {
        const { send, renderChannels } = create(ENGINE_KIND[model]);
        for (const [id, value] of patchEntries(model, defaultPatch(model))) {
            send({ type: 'param', time: 0, id, value });
        }
        send({ type: 'note', id: 0, time: 0.1, frequency: 220, velocity: 1, duration: 0.5 });
        return renderChannels(0, 1, 2).outs as [Float32Array, Float32Array];
    };

    it.each(['analog', 'wavetable', 'fm'] as const)('runs the %s engine in stereo, addressed by patch id', (model) => {
        const [left, right] = playDefault(model);
        expect(peak(left.subarray(0, 0.1 * RATE))).toBe(0);
        expect(peak(left.subarray(0.15 * RATE, 0.5 * RATE))).toBeGreaterThan(0.1);
        expect(peak(right.subarray(0.15 * RATE, 0.5 * RATE))).toBeGreaterThan(0.1);
        expect(left.every(Number.isFinite)).toBe(true);
    });

    it.each(['analog', 'wavetable'] as const)('plays the %s engine at the note’s pitch', (model) => {
        const [left] = playDefault(model);
        expect(pitch(left.subarray(0.2 * RATE, 0.5 * RATE))).toBeCloseTo(220, 0);
    });

    it('spreads analog unison across both sides', () => {
        const { send, renderChannels } = create(ENGINE_KIND.analog);
        send({ type: 'param', time: 0, id: PatchId.unison, value: 5 });
        send({ type: 'param', time: 0, id: PatchId.unisonSpread, value: 1 });
        send({ type: 'note', id: 0, time: 0, frequency: 220, velocity: 1, duration: 1 });
        const [left, right] = renderChannels(0, 0.5, 2).outs as [Float32Array, Float32Array];
        const difference = left.reduce((sum, value, i) => sum + Math.abs(value - right[i]!), 0) / left.length;
        expect(difference).toBeGreaterThan(0.05);
    });

    it('lets the browser collect it after dispose', () => {
        const { send, render } = create();
        send({ type: 'dispose' });
        expect(render(0, 0.01).alive).toBe(false);
    });
});
