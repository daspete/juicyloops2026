import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioRelay, type AudioWorkerStatus } from '../bridge/audioWorker';
import { BridgeClient, type BridgeClientEvent } from '../bridge/client';
import { eventsToFrames, FIRST_TICK, Ticker, type TickHandler } from '../bridge/offline';
import {
    BRIDGE_PROCESSOR,
    KIND_DROPPED,
    bridgeUrl,
    decodeProcess,
    decodeRenderResult,
    decodeResult,
    encodeProcess,
    encodeRender,
    encodeResult,
    isBridgeUrl,
    pluginIdOf,
    processBufferSize,
    type BridgeProcessorOptions,
    type BridgeWorkletMessage,
    type BridgeWorkletStats,
} from '../bridge/protocol';

const here = dirname(fileURLToPath(import.meta.url));
/** The golden frames the Rust bridge's tests check too (`vst-bridge/tests/vectors.rs`). */
const vector = (name: string): Uint8Array => {
    const hex = readFileSync(join(here, '../../../../vst-bridge/tests/vectors', `${name}.hex`), 'utf8').trim();
    return new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
};

describe('bridge protocol', () => {
    it('names desktop plugins with their own scheme', () => {
        const url = bridgeUrl('vst3:5445535453594E5450524F4300000001');
        expect(url).toBe('vstbridge:vst3:5445535453594E5450524F4300000001');
        expect(isBridgeUrl(url)).toBe(true);
        expect(isBridgeUrl('https://example.com/index.js')).toBe(false);
        expect(pluginIdOf(url)).toBe('vst3:5445535453594E5450524F4300000001');
    });

    it('writes a process frame byte for byte as the bridge reads it', () => {
        const buffer = new ArrayBuffer(processBufferSize(3));
        const length = encodeProcess(
            buffer,
            42,
            4096,
            3,
            [
                { frame: 0, bytes: [0x90, 60, 100] },
                { frame: 2, bytes: [0x80, 60, 0] },
            ],
            [new Float32Array([0.5, -0.25, 1]), new Float32Array([0, 0.125, -1])],
        );
        expect(new Uint8Array(buffer, 0, length)).toEqual(vector('process'));
        const decoded = decodeProcess(buffer, length);
        expect(decoded).toMatchObject({ instance: 42, startFrame: 4096, frames: 3, inChannels: 2 });
        expect(decoded.events).toEqual([
            { frame: 0, bytes: [0x90, 60, 100] },
            { frame: 2, bytes: [0x80, 60, 0] },
        ]);
    });

    it('reads the result frames the bridge writes', () => {
        const bytes = vector('result');
        const result = decodeResult(bytes.slice().buffer);
        expect(result).toMatchObject({ instance: 42, startFrame: 4096, frames: 3, outChannels: 2, status: 0, micros: 77 });
        expect([...result.output]).toEqual([0.5, -0.25, 1, 0, 0.125, -1]);
        const mine = new ArrayBuffer(bytes.length);
        encodeResult(mine, 42, 4096, 3, [new Float32Array([0.5, -0.25, 1]), new Float32Array([0, 0.125, -1])], 0, 77);
        expect(new Uint8Array(mine)).toEqual(bytes);
    });

    it('writes render requests and reads render chunks as the bridge does', () => {
        const request = encodeRender(
            7,
            96_000,
            [
                { frame: 5, bytes: [0xe0, 0, 64] },
                { frame: 48_000, bytes: [0x90, 64, 90] },
            ],
            [],
            8,
        );
        expect(new Uint8Array(request)).toEqual(vector('render'));
        const chunk = decodeRenderResult(vector('render-result').slice().buffer);
        expect(chunk).toMatchObject({ instance: 7, startFrame: 4096, frames: 2, outChannels: 2, last: true, error: null });
        expect([...chunk.output]).toEqual([0.25, 0.5, -0.25, -0.5]);
    });
});

/* ---------------------------------------------------------------- the worklet, in Node */

type Packet = { buffer: ArrayBuffer; length: number };

interface FakeLink {
    sent: Packet[];
    onmessage: ((event: { data: Packet }) => void) | null;
    postMessage(data: Packet): void;
    close(): void;
}

const fakeLink = (): FakeLink => ({
    sent: [],
    onmessage: null,
    postMessage(data: Packet) {
        this.sent.push(data);
    },
    close() {},
});

describe('bridge worklet', () => {
    const RATE = 48_000;
    type Processor = {
        port: { onmessage: ((event: { data: BridgeWorkletMessage }) => void) | null; postMessage: (message: unknown) => void };
        process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    };
    let Processor: new (options: { processorOptions: BridgeProcessorOptions }) => Processor;
    let registeredAs = '';

    beforeAll(async () => {
        vi.stubGlobal('sampleRate', RATE);
        vi.stubGlobal('currentFrame', 0);
        vi.stubGlobal(
            'AudioWorkletProcessor',
            class {
                readonly port = {
                    onmessage: null,
                    posted: [] as unknown[],
                    postMessage(message: unknown) {
                        this.posted.push(message);
                    },
                };
            },
        );
        vi.stubGlobal('registerProcessor', (name: string, processor: typeof Processor) => {
            registeredAs = name;
            Processor = processor;
        });
        await import('../bridge/bridgeProcessor');
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    /**
     * A worklet wired to a fake bridge: each request is answered after `trip` quanta by `answer` (planar output for
     * the block), written into the request's own buffer as the audio worker does.
     */
    const rig = (options: Partial<BridgeProcessorOptions>, answer: (request: ReturnType<typeof decodeProcess>) => Float32Array[], trip = 2) => {
        const settings: BridgeProcessorOptions = {
            instance: 9,
            mode: 'instrument',
            blockFrames: 256,
            aheadFrames: 512,
            delayFrames: 640,
            buffers: 16,
            ...options,
        };
        const processor = new Processor({ processorOptions: settings });
        const link = fakeLink();
        const send = (message: BridgeWorkletMessage) => processor.port.onmessage!({ data: message });
        send({ type: 'link', port: link as unknown as MessagePort });
        const requests: ReturnType<typeof decodeProcess>[] = [];
        const inFlight: { due: number; packet: Packet }[] = [];
        let frame = 0;
        const quantum = (input?: Float32Array[]) => {
            vi.stubGlobal('currentFrame', frame);
            // Answers that are due arrive before the audio thread's next turn.
            for (const flight of inFlight.filter((flight) => flight.due <= frame)) {
                inFlight.splice(inFlight.indexOf(flight), 1);
                link.onmessage!({ data: flight.packet });
            }
            const left = new Float32Array(128).fill(NaN);
            const right = new Float32Array(128).fill(NaN);
            processor.process(input ? [input] : [[]], [[left, right]]);
            for (const packet of link.sent.splice(0)) {
                const request = decodeProcess(packet.buffer, packet.length);
                requests.push({ ...request, events: [...request.events], input: request.input.slice() });
                const length = encodeResult(packet.buffer, request.instance, request.startFrame, request.frames, answer(request));
                inFlight.push({ due: frame + trip * 128, packet: { buffer: packet.buffer, length } });
            }
            frame += 128;
            return { left, right };
        };
        const run = (quanta: number, input?: (frame: number) => number) => {
            const left: number[] = [];
            const right: number[] = [];
            for (let index = 0; index < quanta; index++) {
                const start = frame;
                const samples = input ? [Float32Array.from({ length: 128 }, (_, i) => input(start + i))] : undefined;
                const out = quantum(samples);
                left.push(...out.left);
                right.push(...out.right);
            }
            return { left, right };
        };
        const stats = (): BridgeWorkletStats => {
            const port = processor.port as unknown as { posted: BridgeWorkletStats[] };
            send({ type: 'stats' });
            return port.posted[port.posted.length - 1]!;
        };
        return { processor, send, run, requests, stats, link, inFlight, free: () => (processor as unknown as { free: ArrayBuffer[] }).free.length };
    };

    /** The bridge's answer for an instrument: every sample is its own frame on the timeline (right: negative). */
    const timeline = (request: ReturnType<typeof decodeProcess>) => {
        const left = Float32Array.from({ length: request.frames }, (_, i) => request.startFrame + i);
        return [left, left.map((value) => -value)];
    };

    it('registers under the name the main thread asks for', () => {
        expect(registeredAs).toBe(BRIDGE_PROCESSOR);
    });

    it('asks for instrument blocks ahead of time and plays each on its own frames', () => {
        const { run, requests, stats } = rig({}, timeline, 2);
        const { left, right } = run(40);
        // The first block came back too late (asked for at frame 0, back at 256); from frame 256 on every frame is right.
        for (let frame = 256; frame < left.length; frame++) {
            expect(left[frame]).toBe(frame);
            expect(right[frame]).toBe(-frame);
        }
        expect(requests.map((request) => request.startFrame).slice(0, 4)).toEqual([0, 256, 512, 768]);
        const counters = stats();
        expect(counters.underruns).toBe(0);
        expect(counters.late).toBe(1);
        expect(counters.roundTrip.max).toBe(256);
    });

    it('puts a note into the block of its frame, at its offset', () => {
        const { run, send, requests, stats } = rig({}, timeline);
        send({ type: 'midi', time: 1000 / RATE, bytes: [0x90, 64, 100] });
        send({ type: 'midi', time: 1000 / RATE, bytes: [0x80, 64, 0] });
        send({ type: 'midi', time: 999 / RATE, bytes: [0xe0, 0, 70] });
        run(1);
        // After the first quantum the blocks up to 768 are gone: a note for frame 100 is late and goes first.
        send({ type: 'midi', time: 100 / RATE, bytes: [0x90, 50, 1] });
        run(10);
        const block = requests.find((request) => request.startFrame === 768)!;
        expect(block.events).toEqual([
            { frame: 0, bytes: [0x90, 50, 1] },
            { frame: 231, bytes: [0xe0, 0, 70] },
            { frame: 232, bytes: [0x90, 64, 100] },
            { frame: 232, bytes: [0x80, 64, 0] },
        ]);
        expect(stats().lateEvents).toBe(1);
    });

    it('plays a gap (and counts it) when an answer is late, and catches up after', () => {
        const { run, inFlight, stats } = rig({}, timeline, 2);
        run(20);
        // Hold every answer for a while: the buffer runs dry.
        const held = inFlight.splice(0);
        const gap = run(8);
        expect(gap.left.some((sample) => sample === 0)).toBe(true);
        inFlight.push(...held.map((flight) => ({ ...flight, due: 0 })));
        const after = run(20);
        const offset = 28 * 128;
        for (let index = 10 * 128; index < after.left.length; index++) {
            expect(after.left[index]).toBe(offset + index);
        }
        expect(stats().underruns).toBeGreaterThan(0);
    });

    it('delays an effect by its delay, sample for sample', () => {
        const { run, stats } = rig(
            { mode: 'effect', delayFrames: 640 },
            (request) => [
                request.input.subarray(0, request.frames).map((sample) => sample * 0.5),
                request.input.subarray(request.frames).map((sample) => sample * -0.5),
            ],
            1,
        );
        const { left, right } = run(30, (frame) => frame + 1);
        for (let frame = 640 + 256; frame < left.length; frame++) {
            expect(left[frame]).toBe((frame - 640 + 1) * 0.5);
            expect(right[frame]).toBe((frame - 640 + 1) * -0.5);
        }
        expect(stats().underruns).toBe(0);
    });

    it('reuses its buffers: none are made while it plays', () => {
        const { run, free, inFlight } = rig({}, timeline, 3);
        run(50);
        const settled = free() + inFlight.length;
        run(500);
        // Every buffer is in the pool, out on the wire, or waiting to play: the same count as before.
        expect(free() + inFlight.length).toBeLessThanOrEqual(16);
        expect(Math.abs(free() + inFlight.length - settled)).toBeLessThanOrEqual(3);
    });

    it('hands buffers back when the bridge is away, and stops when told', () => {
        const { processor, send, run, link, stats } = rig({}, timeline);
        run(4);
        // The worker marks unsent buffers as dropped and returns them.
        const buffer = new ArrayBuffer(processBufferSize(256));
        new DataView(buffer).setUint8(0, KIND_DROPPED);
        link.onmessage!({ data: { buffer, length: 1 } });
        expect(stats().dropped).toBe(1);
        send({ type: 'stop' });
        expect(processor.process([[]], [[new Float32Array(128), new Float32Array(128)]])).toBe(false);
    });
});

/* ---------------------------------------------------------------- the audio worker's relay */

class FakeSocket {
    static last: FakeSocket;
    binaryType = 'blob';
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
        FakeSocket.last = this;
    }
    send(data: unknown) {
        this.sent.push(data);
    }
    close() {
        this.closed = true;
        this.onclose?.();
    }
}

describe('bridge audio relay', () => {
    const port = () => ({
        posted: [] as { data: unknown; transfer: unknown[] }[],
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(data: unknown, transfer: unknown[] = []) {
            this.posted.push({ data, transfer });
        },
        close() {},
    });

    it('sends requests once the bridge said hello, and answers in the request buffers', () => {
        const statuses: AudioWorkerStatus[] = [];
        const relay = new AudioRelay(
            (status) => statuses.push(status),
            (url) => new FakeSocket(url) as unknown as WebSocket,
        );
        relay.handle({ type: 'connect', port: 47817, token: 'abc' });
        const socket = FakeSocket.last;
        expect(socket.url).toBe('ws://127.0.0.1:47817/audio');
        const instancePort = port();
        relay.handle({ type: 'attach', instance: 5, port: instancePort as unknown as MessagePort });

        // Before the hello: handed back as dropped.
        const early = new ArrayBuffer(processBufferSize(256));
        instancePort.onmessage!({ data: { buffer: early, length: 40 } });
        expect((instancePort.posted[0]!.data as Packet).length).toBe(1);
        expect(new DataView(early).getUint8(0)).toBe(KIND_DROPPED);

        socket.onopen!();
        expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ type: 'hello', token: 'abc', protocol: 1 });
        socket.onmessage!({ data: JSON.stringify({ id: 1, ok: true, result: {} }) });
        expect(statuses).toEqual([{ type: 'status', state: 'open' }]);

        const request = new ArrayBuffer(processBufferSize(256));
        const length = encodeProcess(request, 5, 0, 256, []);
        instancePort.onmessage!({ data: { buffer: request, length } });
        expect((socket.sent[1] as Uint8Array).byteLength).toBe(length);

        const answer = new ArrayBuffer(24 + 2 * 256 * 4);
        encodeResult(answer, 5, 0, 256, [new Float32Array(256).fill(0.25), new Float32Array(256).fill(-0.25)]);
        socket.onmessage!({ data: answer });
        const back = instancePort.posted[1]!.data as Packet;
        expect(back.buffer).toBe(request);
        expect(back.length).toBe(answer.byteLength);
        expect(decodeResult(back.buffer, back.length).output[0]).toBe(0.25);

        // Answers for instances nobody listens to are dropped quietly.
        encodeResult(answer, 99, 0, 256, []);
        socket.onmessage!({ data: answer });
        expect(instancePort.posted).toHaveLength(2);
    });

    it('reports a refused token', () => {
        const statuses: AudioWorkerStatus[] = [];
        const relay = new AudioRelay(
            (status) => statuses.push(status),
            (url) => new FakeSocket(url) as unknown as WebSocket,
        );
        relay.handle({ type: 'connect', port: 1, token: 'nope' });
        FakeSocket.last.onopen!();
        FakeSocket.last.onmessage!({ data: JSON.stringify({ id: 1, ok: false, error: { code: 'unauthorized', message: 'The pairing token is wrong.' } }) });
        expect(statuses).toEqual([{ type: 'status', state: 'refused', message: 'The pairing token is wrong.' }]);
    });
});

/* ---------------------------------------------------------------- the control client */

/** A bridge that answers like the real one. */
const server = (behaviour: { token?: string; plugins?: unknown[] } = {}) => {
    const sockets: FakeSocket[] = [];
    const makeSocket = (url: string) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        socket.send = (data: unknown) => {
            socket.sent.push(data);
            const request = JSON.parse(data as string) as { id: number; type: string; token?: string };
            const reply = (body: object) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ id: request.id, ...body }) }));
            if (request.type === 'hello') {
                if (request.token === (behaviour.token ?? 'good')) {
                    reply({
                        ok: true,
                        result: { bridge: 'juicyloops-bridge', version: '0.1.0', protocol: 1, os: 'linux', formats: ['clap', 'vst3'], editors: true },
                    });
                } else {
                    reply({ ok: false, error: { code: 'unauthorized', message: 'The pairing token is wrong.' } });
                }
            } else if (request.type === 'listPlugins') {
                reply({ ok: true, result: { plugins: behaviour.plugins ?? [], scanning: false } });
            } else if (request.type === 'getState') {
                reply({ ok: true, result: { state: 'AAEC' } });
            } else {
                reply({ ok: false, error: { code: 'not-found', message: `No ${request.type}` } });
            }
        };
        queueMicrotask(() => socket.onopen?.());
        return socket as unknown as WebSocket;
    };
    return { sockets, makeSocket };
};

describe('bridge client', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    const SYNTH = {
        id: 'clap:org.example.synth',
        format: 'clap',
        nativeId: 'org.example.synth',
        name: 'Synth',
        vendor: 'Example',
        version: '1',
        kind: 'instrument',
        categories: [],
        path: '/x.clap',
    };

    it('pairs with the token, remembers it, and lists the plugins', async () => {
        const fake = server({ plugins: [SYNTH] });
        const client = new BridgeClient({ makeSocket: fake.makeSocket, makeWorker: () => ({}) as Worker });
        await client.pair('good');
        expect(client.state.value).toBe('ready');
        expect(client.info.value?.editors).toBe(true);
        expect(localStorage.getItem('juicyloops:bridge:token')).toBe('good');
        await client.refreshPlugins();
        expect(client.plugins.value.map((plugin) => plugin.name)).toEqual(['Synth']);
        expect(await client.getState(3)).toBe('AAEC');
        await expect(client.params(3)).rejects.toMatchObject({ code: 'not-found' });
    });

    it('says when the token is wrong, and when nothing listens', async () => {
        const fake = server();
        const client = new BridgeClient({ makeSocket: fake.makeSocket });
        await expect(client.pair('bad')).rejects.toMatchObject({ code: 'unauthorized' });
        expect(client.state.value).toBe('unpaired');

        const nobody = new BridgeClient({
            makeSocket: (url) => {
                const socket = new FakeSocket(url);
                queueMicrotask(() => socket.close());
                return socket as unknown as WebSocket;
            },
        });
        await expect(nobody.connect()).rejects.toMatchObject({ code: 'offline' });
        expect(nobody.state.value).toBe('offline');
        expect(nobody.message.value).toMatch(/not running/);
    });

    it('passes the bridge’s events on, and tries again while plugins use it', async () => {
        vi.useFakeTimers();
        try {
            const fake = server();
            const client = new BridgeClient({ makeSocket: fake.makeSocket, makeWorker: () => ({ postMessage() {}, terminate() {} }) as unknown as Worker });
            localStorage.setItem('juicyloops:bridge:token', 'good');
            client.token.value = 'good';
            const events: BridgeClientEvent[] = [];
            client.onEvent((event) => events.push(event));
            await client.connect();
            fake.sockets[0]!.onmessage!({ data: JSON.stringify({ event: 'editorClosed', instance: 4 }) });
            expect(events).toContainEqual({ event: 'editorClosed', instance: 4 });

            client.retain();
            fake.sockets[0]!.close();
            expect(events).toContainEqual({ event: 'disconnected' });
            expect(client.state.value).toBe('offline');
            await vi.advanceTimersByTimeAsync(1500);
            expect(fake.sockets).toHaveLength(2);
            expect(client.state.value).toBe('ready');
            expect(events.filter((event) => event.event === 'connected')).toHaveLength(2);
            client.release();
        } finally {
            vi.useRealTimers();
        }
    });
});

/* ---------------------------------------------------------------- exports */

describe('bridge exports', () => {
    const context = (length: number) => {
        const pauses: { seconds: number; resolve: () => void }[] = [];
        const fake = {
            sampleRate: 48_000,
            length,
            resumed: 0,
            suspend: (seconds: number) => new Promise<void>((resolve) => pauses.push({ seconds, resolve })),
            resume: () => {
                fake.resumed++;
                return Promise.resolve();
            },
        };
        return { fake, pauses };
    };

    it('pauses once per frame for every plugin that wants it, and goes on when one fails', async () => {
        const { fake, pauses } = context(48_000);
        const ticker = new Ticker(fake);
        const seen: string[] = [];
        const everyBlock: TickHandler = async (frame) => {
            seen.push(`effect ${frame}`);
            return frame + 512;
        };
        const once: TickHandler = async (frame) => {
            seen.push(`instrument ${frame}`);
            throw new Error('the bridge went away');
        };
        ticker.want(once, FIRST_TICK);
        ticker.want(everyBlock, 512);
        expect(pauses.map((pause) => pause.seconds * 48_000)).toEqual([128, 512]);
        pauses.shift()!.resolve();
        await vi.waitFor(() => expect(fake.resumed).toBe(1));
        pauses.shift()!.resolve();
        await vi.waitFor(() => expect(fake.resumed).toBe(2));
        expect(seen).toEqual(['instrument 128', 'effect 512']);
        expect(pauses.map((pause) => pause.seconds * 48_000)).toEqual([1024]);
    });

    it('never pauses past the end of the export', () => {
        const { fake, pauses } = context(1000);
        new Ticker(fake).want(async () => null, 4096);
        expect(pauses).toHaveLength(0);
    });

    it('turns event times into sorted render frames, keeping the order of equal ones', () => {
        const frames = eventsToFrames(
            [
                { time: 0.5, bytes: [0x80, 60, 0] },
                { time: 0.25, bytes: [0x90, 60, 100] },
                { time: 0.5, bytes: [0x90, 62, 100] },
                { time: 9, bytes: [0x90, 1, 1] },
            ],
            48_000,
            48_000,
        );
        expect(frames).toEqual([
            { frame: 12_000, bytes: [0x90, 60, 100] },
            { frame: 24_000, bytes: [0x80, 60, 0] },
            { frame: 24_000, bytes: [0x90, 62, 100] },
        ]);
    });
});
