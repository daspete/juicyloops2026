/**
 * Signalsmith Stretch (MIT), compiled to WASM from `juicyloops/dsp/stretch/` (`yarn dsp:build`): the sample
 * worker's time-stretch engine. WSOLA (`../stretch.ts`) is the fallback when this cannot load.
 *
 * The module is standalone (no Emscripten JS glue). Its C API, in frames, with planar buffers:
 *   `sj_alloc(floats) -> ptr`, `sj_free(ptr)`,
 *   `sj_stretch(in, channels, inLen, outLen, sampleRate, semitones, tonalityHz) -> out ptr, or 0 on failure`.
 * The stretch ratio is `outLen / inLen`, the output is aligned with the input, and the output is deterministic.
 *
 * No imports on purpose: `scripts/perf/stretch-ab.mjs` loads this file straight into Node.
 */

/** The ABI this wrapper speaks; `sj_abi_version()` must return it. */
export const SIGNALSMITH_ABI = 1;

/** Stretch factors this close to 1 leave the audio untouched (as `timeStretch` does). */
const IDENTITY_EPSILON = 1e-4;

interface Exports {
    memory: WebAssembly.Memory;
    _initialize(): void;
    sj_abi_version(): number;
    sj_alloc(floats: number): number;
    sj_free(ptr: number): void;
    sj_stretch(input: number, channels: number, inLength: number, outLength: number, sampleRate: number, semitones: number, tonalityHz: number): number;
}

export interface Signalsmith {
    /**
     * Stretches `channels` by `factor` (2 = twice as long), shifting the pitch by `semitones` (0 keeps it).
     * The output is `round(length * factor)` frames long, like `timeStretch`. The input is never modified.
     * Throws when the module fails (out of memory); the caller falls back to WSOLA.
     */
    stretch(channels: readonly Float32Array[], sampleRate: number, factor: number, semitones?: number): Float32Array<ArrayBuffer>[];
}

/** The only import the module has: a memory-growth notification, which needs no answer. */
const imports: WebAssembly.Imports = { env: { emscripten_notify_memory_growth: () => {} } };

/** Wraps an instantiated module. */
const wrap = (instance: WebAssembly.Instance): Signalsmith => {
    const x = instance.exports as unknown as Exports;
    x._initialize();
    const abi = x.sj_abi_version();
    if (abi !== SIGNALSMITH_ABI) {
        throw new Error(`stretch.wasm speaks ABI ${abi}, expected ${SIGNALSMITH_ABI}`);
    }

    return {
        stretch(channels, sampleRate, factor, semitones = 0) {
            const inLength = channels[0]?.length ?? 0;
            if (!(factor > 0) || inLength === 0 || (Math.abs(factor - 1) < IDENTITY_EPSILON && semitones === 0)) {
                return channels.map((channel) => channel.slice());
            }
            const count = channels.length;
            const outLength = Math.max(1, Math.round(inLength * factor));

            const input = x.sj_alloc(count * inLength);
            if (!input) {
                throw new Error('Signalsmith Stretch: out of memory');
            }
            try {
                // Memory may grow on every call into the module, so every view on it is made fresh, right before use.
                const inView = new Float32Array(x.memory.buffer, input, count * inLength);
                channels.forEach((channel, c) => inView.set(channel, c * inLength));

                const output = x.sj_stretch(input, count, inLength, outLength, sampleRate, semitones, 0);
                if (!output) {
                    throw new Error('Signalsmith Stretch failed');
                }
                const outView = new Float32Array(x.memory.buffer, output, count * outLength);
                const result = channels.map((_, c) => outView.slice(c * outLength, (c + 1) * outLength));
                x.sj_free(output);
                return result;
            } finally {
                x.sj_free(input);
            }
        },
    };
};

/** Instantiates the module from its bytes (or an already compiled `WebAssembly.Module`). */
export const instantiateSignalsmith = async (source: BufferSource | WebAssembly.Module): Promise<Signalsmith> => {
    const instance = source instanceof WebAssembly.Module ? await WebAssembly.instantiate(source, imports) : (await WebAssembly.instantiate(source, imports)).instance;
    return wrap(instance);
};

/** Fetches and instantiates the module; streaming when the server sends it as `application/wasm`. */
export const loadSignalsmith = async (url: string): Promise<Signalsmith> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Could not fetch ${url}: ${response.status}`);
    }
    if (typeof WebAssembly.instantiateStreaming === 'function' && response.headers.get('Content-Type')?.startsWith('application/wasm')) {
        return wrap((await WebAssembly.instantiateStreaming(response, imports)).instance);
    }
    return instantiateSignalsmith(await response.arrayBuffer());
};
