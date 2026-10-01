import { HEADER_SIZE, KIND_RENDER_RESULT, decodeRenderResult, decodeResult, encodeRender, kindOf, type MidiEventAt } from './protocol';

/**
 * Bridge plugins in an export (an OfflineAudioContext). The context renders as fast as it can and an AudioWorklet
 * cannot wait for the network, so the rendering is paused (`suspend`) at chosen frames while the bridge works:
 *
 * - **Instrument**: the sequencer schedules every note of the export before rendering starts (Tone runs its clock
 *   first), so at the first pause (frame 128) all notes are known. One `RENDER` request has the bridge render the
 *   whole range as fast as the plugin goes; the answer plays from a buffer source, sample-aligned. Only the first
 *   128 frames (2.7 ms, inside the render's silent pre-roll) are not covered.
 * - **Effect**: its input exists only while rendering, so it is captured in blocks of `OFFLINE_EFFECT_BLOCK`; at
 *   each pause the last block goes to the bridge and its answer is scheduled at once. The effect's output is
 *   therefore `OFFLINE_EFFECT_BLOCK` frames late (10.7 ms at 48 kHz), the same in every export.
 *
 * One `Ticker` per context owns the pauses (a context allows one per frame) and resumes even when a request fails,
 * so a dead bridge makes a silent track, never a stuck export.
 */

export const OFFLINE_EFFECT_BLOCK = 512;
/** The first pause, the earliest an OfflineAudioContext allows (one render quantum in). */
export const FIRST_TICK = 128;
const TICK_TIMEOUT_MS = 30_000;

/** What runs at a pause; returns the next frame it wants a pause at, or null when done. */
export type TickHandler = (frame: number) => Promise<number | null>;

interface SuspendableContext {
    readonly sampleRate: number;
    readonly length: number;
    suspend(seconds: number): Promise<void>;
    resume(): Promise<void>;
}

export class Ticker {
    private readonly wants = new Map<TickHandler, number>();
    private readonly scheduled = new Set<number>();

    constructor(private readonly context: SuspendableContext) {}

    want(handler: TickHandler, frame: number): void {
        const quantized = Math.max(FIRST_TICK, Math.ceil(frame / 128) * 128);
        if (quantized >= this.context.length) {
            this.wants.delete(handler);
            return;
        }
        this.wants.set(handler, quantized);
        if (this.scheduled.has(quantized)) {
            return;
        }
        this.scheduled.add(quantized);
        this.context.suspend(quantized / this.context.sampleRate).then(
            () => void this.fire(quantized),
            (error: unknown) => {
                // Too late to pause there (the render passed it): nothing to do at that frame.
                this.scheduled.delete(quantized);
                console.warn('A bridge plugin could not pause the export.', error);
            },
        );
    }

    private async fire(frame: number): Promise<void> {
        this.scheduled.delete(frame);
        const due = [...this.wants].filter(([, wanted]) => wanted <= frame).map(([handler]) => handler);
        due.forEach((handler) => this.wants.delete(handler));
        try {
            await Promise.all(
                due.map(async (handler) => {
                    let next: number | null = null;
                    try {
                        next = await withTimeout(handler(frame), TICK_TIMEOUT_MS);
                    } catch (error) {
                        console.warn('A bridge plugin failed in the export; it stays silent.', error);
                    }
                    if (next !== null) {
                        this.want(handler, next);
                    }
                }),
            );
        } finally {
            await this.context.resume();
        }
    }
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The bridge took too long.')), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });

const tickers = new WeakMap<object, Ticker>();

export const tickerOf = (context: SuspendableContext): Ticker => {
    let ticker = tickers.get(context);
    if (!ticker) {
        ticker = new Ticker(context);
        tickers.set(context, ticker);
    }
    return ticker;
};

/** Planar float channels collected from `RENDER_RESULT` chunks. */
export const collectRender = (port: MessagePort, frames: number, channels: number): Promise<Float32Array[]> =>
    new Promise((resolve, reject) => {
        const output = Array.from({ length: channels }, () => new Float32Array(frames));
        port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
            const data = event.data;
            if (!(data instanceof ArrayBuffer) || kindOf(data) !== KIND_RENDER_RESULT) {
                return;
            }
            const chunk = decodeRenderResult(data);
            if (chunk.error) {
                reject(new Error(chunk.error));
                return;
            }
            for (let channel = 0; channel < channels; channel++) {
                const source = Math.min(channel, chunk.outChannels - 1);
                if (source >= 0) {
                    output[channel]!.set(chunk.output.subarray(source * chunk.frames, (source + 1) * chunk.frames), chunk.startFrame);
                }
            }
            if (chunk.last) {
                resolve(output);
            }
        };
    });

/** Events in context seconds → render frames, sorted, inside the render. */
export const eventsToFrames = (events: readonly { time: number; bytes: readonly number[] }[], sampleRate: number, frames: number): MidiEventAt[] =>
    events
        .map((event, order) => ({ frame: Math.max(0, Math.round(event.time * sampleRate)), bytes: event.bytes, order }))
        .filter((event) => event.frame < frames)
        .sort((a, b) => a.frame - b.frame || a.order - b.order)
        .map(({ frame, bytes }) => ({ frame, bytes }));

export interface OfflineInstrument {
    /** Where the rendered sound comes out. */
    output: GainNode;
    schedule(time: number, bytes: [number, number, number]): void;
    dispose(): void;
}

/** An instrument in an export: notes are collected, then rendered in one go at the first pause. */
export const offlineInstrument = (context: OfflineAudioContext, instance: number, workerPort: MessagePort): OfflineInstrument => {
    const output = context.createGain();
    const events: { time: number; bytes: [number, number, number] }[] = [];
    let disposed = false;
    const handler: TickHandler = async (frame) => {
        if (disposed || events.length === 0) {
            return null;
        }
        const frames = context.length;
        const done = collectRender(workerPort, frames, 2);
        const request = encodeRender(instance, frames, eventsToFrames(events, context.sampleRate, frames));
        workerPort.postMessage(request, [request]);
        const channels = await done;
        const buffer = context.createBuffer(2, frames, context.sampleRate);
        channels.forEach((samples, channel) => buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, channel));
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(output);
        const at = frame / context.sampleRate;
        source.start(at, at);
        return null;
    };
    tickerOf(context).want(handler, FIRST_TICK);
    return {
        output,
        schedule: (time, bytes) => {
            events.push({ time, bytes });
        },
        dispose: () => {
            disposed = true;
        },
    };
};

export interface OfflineEffect {
    /** The node the effect's input connects to (the capture worklet). */
    input: AudioWorkletNode;
    output: GainNode;
    dispose(): void;
}

/**
 * An effect in an export. `capture` is the bridge worklet in `capture` mode; its link port's other end is
 * `processorPort`. Blocks it captures go to the bridge through `workerPort`; at every pause the block that just
 * ended plays, one block late.
 */
export const offlineEffect = (context: OfflineAudioContext, capture: AudioWorkletNode, processorPort: MessagePort, workerPort: MessagePort): OfflineEffect => {
    const output = context.createGain();
    // Pulled through the graph (its own output is silence) so it runs in every browser.
    capture.connect(output);
    const answers = new Map<number, Float32Array>();
    const waiting = new Map<number, (samples: Float32Array) => void>();
    let disposed = false;

    processorPort.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; length: number }>) => {
        const { buffer, length } = event.data;
        workerPort.postMessage({ buffer, length }, [buffer]);
    };
    workerPort.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; length: number }>) => {
        const { buffer, length } = event.data;
        if (length >= HEADER_SIZE) {
            try {
                const result = decodeResult(buffer, length);
                const samples = new Float32Array(2 * result.frames);
                const left = result.output.subarray(0, result.frames);
                const right = result.outChannels > 1 ? result.output.subarray(result.frames, 2 * result.frames) : left;
                samples.set(left, 0);
                samples.set(right, result.frames);
                const resolve = waiting.get(result.startFrame);
                if (resolve) {
                    waiting.delete(result.startFrame);
                    resolve(samples);
                } else {
                    answers.set(result.startFrame, samples);
                }
            } catch {
                /* not a result: ignore */
            }
        }
        // The buffer goes home to the worklet's pool.
        processorPort.postMessage({ buffer, length: 0 }, [buffer]);
    };

    const answerFor = (start: number): Promise<Float32Array> => {
        const ready = answers.get(start);
        if (ready) {
            answers.delete(start);
            return Promise.resolve(ready);
        }
        return new Promise((resolve) => waiting.set(start, resolve));
    };

    const handler: TickHandler = async (frame) => {
        if (disposed) {
            return null;
        }
        const start = frame - OFFLINE_EFFECT_BLOCK;
        const samples = await answerFor(start);
        const buffer = context.createBuffer(2, OFFLINE_EFFECT_BLOCK, context.sampleRate);
        buffer.copyToChannel(samples.subarray(0, OFFLINE_EFFECT_BLOCK) as Float32Array<ArrayBuffer>, 0);
        buffer.copyToChannel(samples.subarray(OFFLINE_EFFECT_BLOCK) as Float32Array<ArrayBuffer>, 1);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(output);
        source.start(frame / context.sampleRate);
        return frame + OFFLINE_EFFECT_BLOCK;
    };
    tickerOf(context).want(handler, OFFLINE_EFFECT_BLOCK);

    return {
        input: capture,
        output,
        dispose: () => {
            disposed = true;
            for (const resolve of waiting.values()) {
                resolve(new Float32Array(2 * OFFLINE_EFFECT_BLOCK));
            }
            waiting.clear();
        },
    };
};
