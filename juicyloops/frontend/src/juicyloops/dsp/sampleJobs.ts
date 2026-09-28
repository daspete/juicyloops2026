/**
 * Promise API for the sample worker: stretching a region and finding hits without blocking the main thread.
 *
 * - One worker for the whole app, created on the first job (never at import time, so the prerender build and
 *   pages that never stretch anything do not start one). Where there is no `Worker` (jsdom tests, SSR), or it
 *   fails to load, the same code runs inline instead.
 * - Jobs go to the worker one at a time. A job given a `lane` replaces the older one in that lane: if the older
 *   one still waits it is dropped unrun, if it is already running its answer is dropped when it lands. Both
 *   resolve with `null`. A sample track uses one lane, so sweeping the pitch knob never builds a backlog.
 * - Channel data is copied out of the `AudioBuffer` and the copies are transferred, so the decoded sample stays
 *   intact. The copies are made when the job is sent, not when it is queued, so a dropped job costs nothing.
 * - Stretched regions are kept in an LRU cache keyed by (sample, sample rate, region, factor). An export
 *   restores every sample track in a second, offline sequencer; the cache hands those tracks the renditions the
 *   live tracks already made instead of stretching everything again.
 */

import type { OnsetOptions } from '../slices';
import { answerSampleRequest, transferablesOf, type SampleReply, type SampleRequest } from './sampleProtocol';

/** Most samples (all channels together) the rendition cache holds: about 200 MB of floats. */
export const MAX_CACHED_FLOATS = 50_000_000;

/** Whatever answers requests: the worker, or the same code run inline. */
export interface SampleRunner {
    run(request: SampleRequest): Promise<SampleReply>;
}

/** The worker could not be started or died; its jobs are run inline from then on. */
class WorkerUnavailableError extends Error {}

/** Answers on the main thread, after a timer tick so that it behaves like the worker: later jobs can still replace it. */
export const inlineRunner: SampleRunner = {
    run: (request) => new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => answerSampleRequest(request)),
};

class WorkerRunner implements SampleRunner {
    private readonly worker: Worker;
    private readonly pending = new Map<number, { resolve: (reply: SampleReply) => void; reject: (error: unknown) => void }>();

    constructor() {
        // Vite spots this exact pattern and bundles the worker as its own chunk, in dev and in the build.
        this.worker = new Worker(new URL('./sampleWorker.ts', import.meta.url), { type: 'module', name: 'juicyloops-samples' });
        this.worker.onmessage = (event: MessageEvent<SampleReply>) => {
            const job = this.pending.get(event.data.jobId);
            if (job) {
                this.pending.delete(event.data.jobId);
                job.resolve(event.data);
            }
        };
        // Job errors come back as replies, so an error event means the worker itself is broken (did not load, ran out of memory).
        this.worker.onerror = (event) => {
            event.preventDefault();
            this.fail(new WorkerUnavailableError(event.message || 'The sample worker failed'));
        };
        this.worker.onmessageerror = () => this.fail(new WorkerUnavailableError('The sample worker sent an unreadable message'));
    }

    run(request: SampleRequest): Promise<SampleReply> {
        return new Promise((resolve, reject) => {
            this.pending.set(request.jobId, { resolve, reject });
            this.worker.postMessage(request, transferablesOf(request));
        });
    }

    private fail(error: Error): void {
        this.worker.terminate();
        for (const job of this.pending.values()) {
            job.reject(error);
        }
        this.pending.clear();
    }
}

const createRunner = (): SampleRunner => {
    if (typeof Worker === 'undefined') {
        return inlineRunner;
    }
    try {
        return new WorkerRunner();
    } catch (error) {
        console.warn('No sample worker, stretching on the main thread', error);
        return inlineRunner;
    }
};

/** Stretched regions, least recently used first (a `Map` keeps insertion order). Capped by the samples it holds. */
class RenditionCache {
    private readonly entries = new Map<string, Float32Array<ArrayBuffer>[]>();
    private floats = 0;

    constructor(private readonly capacity: number) {}

    get size(): number {
        return this.floats;
    }

    get(key: string): Float32Array<ArrayBuffer>[] | undefined {
        const channels = this.entries.get(key);
        if (channels) {
            this.entries.delete(key);
            this.entries.set(key, channels);
        }
        return channels;
    }

    set(key: string, channels: Float32Array<ArrayBuffer>[]): void {
        const floats = channels.reduce((sum, channel) => sum + channel.length, 0);
        if (floats > this.capacity || this.entries.has(key)) {
            return;
        }
        this.entries.set(key, channels);
        this.floats += floats;
        for (const [oldest, old] of this.entries) {
            if (this.floats <= this.capacity) {
                break;
            }
            this.entries.delete(oldest);
            this.floats -= old.reduce((sum, channel) => sum + channel.length, 0);
        }
    }

    clear(): void {
        this.entries.clear();
        this.floats = 0;
    }
}

export interface StretchJob {
    /** What the audio came from (the sample's blob, or the buffer when there is none). Renditions of the same source are shared through the cache. */
    source: object;
    buffer: AudioBuffer;
    /** The region, in sample frames of `buffer`: `from` inclusive, `to` exclusive. */
    from: number;
    to: number;
    factor: number;
    /** Jobs in the same lane replace each other; see the module comment. */
    lane?: unknown;
}

export interface OnsetsJob {
    buffer: AudioBuffer;
    /** The region to search, in seconds of `buffer`. */
    start: number;
    end: number;
    options?: OnsetOptions;
    lane?: unknown;
}

interface QueuedJob {
    lane: unknown;
    prepare: (jobId: number) => SampleRequest;
    resolve: (reply: SampleReply | null) => void;
    reject: (error: unknown) => void;
    /** A newer job in the same lane came along; the answer is no longer wanted. */
    isStale: boolean;
}

export class SampleJobs {
    private readonly queue: QueuedJob[] = [];
    /** The newest job of every lane. */
    private readonly latest = new Map<unknown, QueuedJob>();
    private readonly cache: RenditionCache;
    private isRunning = false;
    private nextJobId = 1;

    /** `runner` is for tests; by default the worker is created with the first job. */
    constructor(
        private runner: SampleRunner | null = null,
        capacity = MAX_CACHED_FLOATS,
    ) {
        this.cache = new RenditionCache(capacity);
    }

    /** Samples (all channels) the rendition cache holds right now. */
    get cachedFloats(): number {
        return this.cache.size;
    }

    clearCache(): void {
        this.cache.clear();
    }

    /**
     * The region of `job.buffer` stretched by `job.factor`, one array per channel; `null` when a newer job in the
     * same lane replaced this one. The arrays may be shared with the cache: read them, never write or transfer them.
     */
    async stretch(job: StretchJob): Promise<Float32Array<ArrayBuffer>[] | null> {
        const { buffer, from, to, factor } = job;
        const key = `${sourceId(job.source)}|${buffer.sampleRate}|${from}|${to}|${factor}`;
        const cached = this.cache.get(key);
        if (cached) {
            // A hit still replaces whatever the lane was waiting for.
            this.supersede(job.lane);
            return cached;
        }

        const reply = await this.submit(
            job.lane,
            (jobId) => ({
                kind: 'stretch',
                jobId,
                channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice(from, to)),
                sampleRate: buffer.sampleRate,
                factor,
            }),
            (landed) => {
                // Even an answer nobody waits for any more is a valid rendition: keep it, the knob may come back.
                if (landed.kind === 'stretch') {
                    this.cache.set(key, landed.channels);
                }
            },
        );
        if (reply === null) {
            return null;
        }
        return reply.kind === 'stretch' ? reply.channels : unexpected(reply);
    }

    /** The hits in the region (see `detectOnsets`); `null` when a newer job in the same lane replaced this one. */
    async onsets(job: OnsetsJob): Promise<number[] | null> {
        const { buffer } = job;
        const reply = await this.submit(job.lane, (jobId) => ({
            kind: 'onsets',
            jobId,
            // The whole sample goes across, so the times come out exactly as if it ran here.
            channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice()),
            sampleRate: buffer.sampleRate,
            from: job.start,
            to: job.end,
            options: { ...job.options },
        }));
        if (reply === null) {
            return null;
        }
        return reply.kind === 'onsets' ? reply.onsets : unexpected(reply);
    }

    /** Marks the lane's newest job stale; a waiting one is dropped right away. */
    private supersede(lane: unknown): void {
        if (lane === undefined) {
            return;
        }
        const previous = this.latest.get(lane);
        if (!previous) {
            return;
        }
        previous.isStale = true;
        this.latest.delete(lane);
        const index = this.queue.indexOf(previous);
        if (index >= 0) {
            this.queue.splice(index, 1);
            previous.resolve(null);
        }
    }

    private submit(lane: unknown, prepare: (jobId: number) => SampleRequest, onReply?: (reply: SampleReply) => void): Promise<SampleReply | null> {
        return new Promise((resolve, reject) => {
            const job: QueuedJob = {
                lane,
                prepare,
                resolve: (reply) => {
                    if (reply) {
                        onReply?.(reply);
                    }
                    resolve(job.isStale ? null : reply);
                },
                reject,
                isStale: false,
            };
            this.supersede(lane);
            if (lane !== undefined) {
                this.latest.set(lane, job);
            }
            this.queue.push(job);
            void this.drain();
        });
    }

    /** Runs the queue, one job at a time. */
    private async drain(): Promise<void> {
        if (this.isRunning) {
            return;
        }
        this.isRunning = true;
        try {
            for (let job = this.queue.shift(); job; job = this.queue.shift()) {
                try {
                    job.resolve(await this.run(job));
                } catch (error) {
                    job.reject(error);
                }
                if (this.latest.get(job.lane) === job) {
                    this.latest.delete(job.lane);
                }
            }
        } finally {
            this.isRunning = false;
        }
    }

    private async run(job: QueuedJob): Promise<SampleReply> {
        const jobId = this.nextJobId++;
        const runner = (this.runner ??= createRunner());
        try {
            return await runner.run(job.prepare(jobId));
        } catch (error) {
            if (!(error instanceof WorkerUnavailableError)) {
                throw error;
            }
            // The data sent along was transferred and is gone with the worker; `prepare` copies it again.
            console.warn('The sample worker failed, stretching on the main thread from now on', error);
            this.runner = inlineRunner;
            return inlineRunner.run(job.prepare(jobId));
        }
    }
}

/** A job the worker could not do comes back as an error reply; anything else would be a mix-up of the protocol. */
const unexpected = (reply: SampleReply): never => {
    throw new Error(reply.kind === 'error' ? reply.message : `Unexpected ${reply.kind} reply from the sample worker`);
};

/* Blobs and buffers have no id of their own; each gets a number the first time it is seen. Weak, so samples can still be freed. */
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;
const sourceId = (source: object): number => {
    let id = sourceIds.get(source);
    if (id === undefined) {
        id = nextSourceId++;
        sourceIds.set(source, id);
    }
    return id;
};

let shared: SampleJobs | null = null;

/** The app's one `SampleJobs`, made on first use. */
export const sampleJobs = (): SampleJobs => (shared ??= new SampleJobs());
