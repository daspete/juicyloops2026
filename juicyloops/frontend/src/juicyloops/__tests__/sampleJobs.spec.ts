import { describe, expect, it } from 'vitest';
import { SampleJobs, type SampleRunner } from '../dsp/sampleJobs';
import type { SampleReply, SampleRequest } from '../dsp/sampleProtocol';
import { detectOnsets } from '../slices';
import { timeStretch } from '../stretch';

const RATE = 8000;

/** jsdom has no Web Audio: just enough of an `AudioBuffer` for the jobs to read from. */
const fakeBuffer = (channels: Float32Array[]): AudioBuffer =>
    ({
        numberOfChannels: channels.length,
        length: channels[0]!.length,
        sampleRate: RATE,
        duration: channels[0]!.length / RATE,
        getChannelData: (channel: number) => channels[channel]!,
    }) as unknown as AudioBuffer;

const sine = (frequency: number, seconds: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.sin((2 * Math.PI * frequency * i) / RATE));

/** Silence with a short click every `every` seconds. */
const clicks = (seconds: number, every: number) => {
    const signal = new Float32Array(Math.round(seconds * RATE));
    for (let t = 0; t < seconds; t += every) {
        for (let i = 0; i < 200; i++) {
            signal[Math.round(t * RATE) + i] = Math.sin(i) * Math.exp(-i / 40);
        }
    }
    return signal;
};

/** A runner that answers only when the test says so, and remembers what it was asked. */
const manualRunner = () => {
    const requests: SampleRequest[] = [];
    const open: { request: SampleRequest; resolve: (reply: SampleReply) => void }[] = [];
    const runner: SampleRunner = {
        run: (request) =>
            new Promise((resolve) => {
                requests.push(request);
                open.push({ request, resolve });
            }),
    };
    /** Answers the oldest open request of a stretch with a one-sample array holding its factor. */
    const answer = async () => {
        const { request, resolve } = open.shift()!;
        resolve({ kind: 'stretch', jobId: request.jobId, channels: [Float32Array.of(request.kind === 'stretch' ? request.factor : 0)] });
        // Let the queue hand the next job to the runner.
        await new Promise((next) => setTimeout(next, 0));
    };
    return { runner, requests, answer };
};

const flush = () => new Promise((next) => setTimeout(next, 0));

describe('sample jobs', () => {
    it('runs inline where there is no Worker, with the same results and without touching the sample', async () => {
        expect(typeof Worker).toBe('undefined');
        const jobs = new SampleJobs();
        const left = sine(220, 0.5);
        const right = sine(330, 0.5);
        const before = [left.slice(), right.slice()];
        const buffer = fakeBuffer([left, right]);

        const stretched = await jobs.stretch({ source: buffer, buffer, from: 400, to: 3600, factor: 1.5 });
        expect(stretched).toEqual(timeStretch([left.subarray(400, 3600), right.subarray(400, 3600)], RATE, 1.5));
        expect([left, right]).toEqual(before);

        const signal = clicks(1, 0.25);
        const onsets = await jobs.onsets({ buffer: fakeBuffer([signal]), start: 0, end: 1, options: { sensitivity: 0.5 } });
        expect(onsets).toEqual(detectOnsets([signal], RATE, 0, 1, { sensitivity: 0.5 }));
        expect(onsets!.length).toBeGreaterThan(0);
    });

    it('drops a job a newer one in the same lane replaced, whether it waited or was already running', async () => {
        const { runner, requests, answer } = manualRunner();
        const jobs = new SampleJobs(runner);
        const buffer = fakeBuffer([sine(220, 0.1)]);
        const lane = Symbol('track');
        const job = (factor: number, jobLane: unknown = lane) => jobs.stretch({ source: buffer, buffer, from: 0, to: 800, factor, lane: jobLane });

        const running = job(1.1);
        await flush();
        const waiting = job(1.2);
        const other = job(3, Symbol('other track'));
        const newest = job(1.3);

        // The waiting one is gone before it ever ran.
        await expect(waiting).resolves.toBeNull();

        await answer();
        await expect(running).resolves.toBeNull();
        await answer();
        await expect(other).resolves.toEqual([Float32Array.of(3)]);
        await answer();
        await expect(newest).resolves.toEqual([Float32Array.of(1.3)]);

        expect(requests.map((request) => (request.kind === 'stretch' ? request.factor : 0))).toEqual([1.1, 3, 1.3]);
        const ids = requests.map((request) => request.jobId);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('hands out a cached rendition for the same sample, region and factor', async () => {
        const { runner, requests, answer } = manualRunner();
        const jobs = new SampleJobs(runner);
        const blob = {};
        const buffer = fakeBuffer([sine(220, 0.1)]);
        // A second decode of the same blob (the export's offline sequencer does that) shares the cache.
        const decodedAgain = fakeBuffer([sine(220, 0.1)]);

        const first = jobs.stretch({ source: blob, buffer, from: 0, to: 800, factor: 1.5 });
        await flush();
        await answer();
        const channels = await first;
        expect(requests).toHaveLength(1);

        await expect(jobs.stretch({ source: blob, buffer: decodedAgain, from: 0, to: 800, factor: 1.5 })).resolves.toBe(channels);
        expect(requests).toHaveLength(1);
        expect(jobs.cachedFloats).toBe(1);

        // Another factor, region or sample is work of its own.
        void jobs.stretch({ source: blob, buffer, from: 0, to: 800, factor: 2 });
        void jobs.stretch({ source: blob, buffer, from: 0, to: 400, factor: 1.5 });
        void jobs.stretch({ source: {}, buffer, from: 0, to: 800, factor: 1.5 });
        await flush();
        await answer();
        await answer();
        await answer();
        expect(requests).toHaveLength(4);
    });

    it('keeps the answer of a replaced job, so turning the knob back needs no new stretch', async () => {
        const { runner, requests, answer } = manualRunner();
        const jobs = new SampleJobs(runner);
        const buffer = fakeBuffer([sine(220, 0.1)]);
        const lane = Symbol('track');

        const replaced = jobs.stretch({ source: buffer, buffer, from: 0, to: 800, factor: 1.5, lane });
        await flush();
        const newer = jobs.stretch({ source: buffer, buffer, from: 0, to: 800, factor: 2, lane });
        await answer();
        await answer();
        await expect(replaced).resolves.toBeNull();
        await expect(newer).resolves.not.toBeNull();

        await expect(jobs.stretch({ source: buffer, buffer, from: 0, to: 800, factor: 1.5, lane })).resolves.toEqual([Float32Array.of(1.5)]);
        expect(requests).toHaveLength(2);
    });

    it('forgets the least recently used renditions past its capacity', async () => {
        const jobs = new SampleJobs(null, 2 * 1600);
        const buffer = fakeBuffer([sine(220, 0.2)]);
        const stretch = (factor: number) => jobs.stretch({ source: buffer, buffer, from: 0, to: 800, factor });

        await stretch(2);
        await stretch(1.5);
        expect(jobs.cachedFloats).toBe(1600 + 1200);
        // Using the first one again makes the second the oldest; a third pushes that one out.
        await stretch(2);
        await stretch(1.25);
        expect(jobs.cachedFloats).toBe(1600 + 1000);
    });

    it('rejects when the job fails', async () => {
        const jobs = new SampleJobs({ run: async (request) => ({ kind: 'error', jobId: request.jobId, message: 'no memory' }) });
        const buffer = fakeBuffer([sine(220, 0.1)]);
        await expect(jobs.stretch({ source: buffer, buffer, from: 0, to: 800, factor: 2 })).rejects.toThrow('no memory');
    });
});
