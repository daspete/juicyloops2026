/**
 * The messages the sample worker understands, and the code that answers them.
 *
 * Kept apart from `sampleWorker.ts` so the same code runs inline where there is no `Worker` (tests, the
 * prerender build): `sampleJobs.ts` either posts a request to the worker or calls `answerSampleRequest` itself.
 *
 * Channel data travels as plain `Float32Array`s, one per channel, and is transferred, not copied: whoever sends
 * a request gives up its arrays. The stretch request names only the factor, not the algorithm: the worker
 * stretches with Signalsmith Stretch (WASM, `signalsmith.ts`) and falls back to WSOLA (`../stretch.ts`) when the
 * module cannot load or a job fails in it. Inline (tests, no `Worker`) it is always WSOLA.
 *
 * Pitch is not part of the request on purpose. A sample track pitches by stretching with the pitch ratio and
 * playing the result at that rate (see `SampleTrack`), not with Signalsmith's own transposition. Measured
 * (2026-09-28, `scripts/perf/stretch-ab.mjs` has the listening side): played back through a rate change the
 * pitch is exact (0.00 cents for pure tones at 55-440 Hz, ±3/±7/±12 st, 0.5×-2×), while the direct transpose
 * detunes low notes: +10 to +22 cents at 110-220 Hz and +21 to +79 cents at 55 Hz, mostly downwards. Its only
 * gain was somewhat quicker drum attacks (10-90 % rise 4.8-6.3 ms instead of 5.5-10.7 ms at ±7/±12 st and 1×),
 * not worth a detuned bass.
 */

import { detectOnsets, type OnsetOptions } from '../slices';
import { timeStretch } from '../stretch';

/** Stretches channels by a factor keeping the pitch; `timeStretch` (WSOLA) or Signalsmith Stretch. */
export type StretchEngine = (channels: Float32Array<ArrayBuffer>[], sampleRate: number, factor: number) => Float32Array<ArrayBuffer>[];

/** Stretch `channels` by `factor` (2 = twice as long), keeping the pitch. Answered with the stretched channels. */
export interface StretchRequest {
    kind: 'stretch';
    jobId: number;
    channels: Float32Array<ArrayBuffer>[];
    sampleRate: number;
    factor: number;
}

/** Find the hits between `from` and `to` (seconds in `channels`). Answered with the cut times, in seconds. */
export interface OnsetsRequest {
    kind: 'onsets';
    jobId: number;
    channels: Float32Array<ArrayBuffer>[];
    sampleRate: number;
    from: number;
    to: number;
    options: OnsetOptions;
}

export type SampleRequest = StretchRequest | OnsetsRequest;

export type SampleReply =
    | { kind: 'stretch'; jobId: number; channels: Float32Array<ArrayBuffer>[] }
    | { kind: 'onsets'; jobId: number; onsets: number[] }
    /** The job threw; the message is all that crosses the thread boundary. */
    | { kind: 'error'; jobId: number; message: string };

/** The buffers a message can hand over instead of copying. */
export const transferablesOf = (message: SampleRequest | SampleReply): ArrayBuffer[] =>
    'channels' in message ? message.channels.map((channel) => channel.buffer) : [];

/**
 * Does the work a request asks for. `stretch` is the engine for stretch requests (the worker passes Signalsmith
 * once it has loaded); when it throws, the job is done with WSOLA instead.
 */
export const answerSampleRequest = async (request: SampleRequest, stretch: StretchEngine = timeStretch): Promise<SampleReply> => {
    try {
        switch (request.kind) {
            case 'stretch':
                return { kind: 'stretch', jobId: request.jobId, channels: stretchOrFallBack(stretch, request) };
            case 'onsets':
                return { kind: 'onsets', jobId: request.jobId, onsets: detectOnsets(request.channels, request.sampleRate, request.from, request.to, request.options) };
        }
    } catch (error) {
        return { kind: 'error', jobId: request.jobId, message: error instanceof Error ? error.message : String(error) };
    }
};

const stretchOrFallBack = (stretch: StretchEngine, { channels, sampleRate, factor }: StretchRequest): Float32Array<ArrayBuffer>[] => {
    if (stretch === timeStretch) {
        return timeStretch(channels, sampleRate, factor);
    }
    try {
        return stretch(channels, sampleRate, factor);
    } catch (error) {
        console.warn('Signalsmith Stretch failed on a job, using WSOLA for it', error);
        return timeStretch(channels, sampleRate, factor);
    }
};
