/**
 * The sample worker: stretching and hit detection, off the main thread, so turning the pitch knob never stalls
 * the UI or Tone's scheduler. Created by `sampleJobs.ts`; the messages are described in `sampleProtocol.ts`.
 *
 * Requests arrive one at a time (the main thread only sends the next once this one is answered), so jobs that
 * went stale while they waited are dropped over there and never reach this thread.
 *
 * Stretching uses Signalsmith Stretch (`signalsmith.ts`), loaded with the first stretch job. If the module
 * cannot be fetched or instantiated, WSOLA does every job instead (warned once).
 */

import { loadSignalsmith, type Signalsmith } from './signalsmith';
import { answerSampleRequest, transferablesOf, type SampleRequest, type StretchEngine } from './sampleProtocol';
// Vite emits the module as a hashed asset (in the worker bundle too) and hands over its URL.
import stretchWasmUrl from './wasm/stretch.wasm?url';

let signalsmith: Promise<Signalsmith | null> | null = null;

/** Signalsmith Stretch, loaded once; `null` when it could not load. */
const loadEngine = (): Promise<Signalsmith | null> =>
    (signalsmith ??= loadSignalsmith(stretchWasmUrl).catch((error: unknown) => {
        console.warn('Could not load Signalsmith Stretch, stretching with WSOLA', error);
        return null;
    }));

self.onmessage = async (event: MessageEvent<SampleRequest>) => {
    const request = event.data;
    let engine: StretchEngine | undefined;
    if (request.kind === 'stretch') {
        const loaded = await loadEngine();
        if (loaded) {
            engine = (channels, sampleRate, factor) => loaded.stretch(channels, sampleRate, factor);
        }
    }
    const reply = await answerSampleRequest(request, engine);
    self.postMessage(reply, { transfer: transferablesOf(reply) });
};
