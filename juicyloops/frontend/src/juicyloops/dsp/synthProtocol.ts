/**
 * What the main thread and the synth worklet (`synthProcessor.ts`, running `wasm/synth-worklet.wasm`) say to each
 * other, and the conversion from a track's notes to those messages (`SynthEvents`).
 *
 * No runtime imports on purpose: the processor imports this module's types, and the tests drive `SynthEvents`
 * with a stubbed port.
 */

/** The ABI of `synth-worklet.wasm` this code speaks; the processor checks `abi_version()` against it. */
export const SYNTH_ABI = 3;

/** The name the processor registers under. `synthProcessor.ts` repeats it (it may not import anything at runtime). */
export const SYNTH_PROCESSOR = 'juicyloops-synth';

/** Parameter ids of the engine's `set_param` (see `juicyloops_dsp_core::Param`). */
export const SynthParam = {
    waveform: 0,
    attack: 1,
    decay: 2,
    sustain: 3,
    release: 4,
    /** Pitch bend of every voice, in semitones. */
    bend: 5,
} as const;

export type SynthParamName = keyof typeof SynthParam;

/** Waveform numbers of the engine, by Tone's oscillator type names. */
export const WAVEFORMS = { sine: 0, square: 1, triangle: 2, sawtooth: 3 } as const;

/**
 * Times are audio-context seconds (the same clock as the worklet's `currentFrame / sampleRate`). A `time` of 0 (or
 * anything in the past) means "at the start of the next block".
 */
export type SynthMessage =
    /**
     * `id` 0 is a scheduled note (released after `duration` seconds). A live note has an id above 0 and may be held:
     * a negative `duration` keeps it sounding until a `noteOff` with its id.
     */
    | { type: 'note'; time: number; id: number; frequency: number; velocity: number; duration: number }
    | { type: 'noteOff'; time: number; id: number }
    | { type: 'param'; time: number; id: number; value: number }
    | { type: 'mode'; mono: boolean }
    /** The node is going away: the processor stops asking to be called, so the browser can collect it. */
    | { type: 'dispose' };

/** `processorOptions` of the worklet node. `WebAssembly.Module` is structured-cloneable, so it is compiled only once. */
export interface SynthProcessorOptions {
    module: WebAssembly.Module;
    abi: number;
}

export interface SynthPort {
    postMessage(message: SynthMessage): void;
}

/** How notes and lengths become numbers; `SynthVoices` answers these with Tone, on the node's own context. */
export interface SynthConversions {
    /** A note ('A4') or a frequency in Hz, as Hz. */
    frequency(note: string | number): number;
    /** A note length ('16n', seconds, ...) as seconds at the transport's current tempo. */
    seconds(duration: string | number): number;
}

/**
 * Turns note triggers and parameter changes into worklet messages. Until the worklet node exists (its module is
 * still loading), the messages wait here and go out in order once `attach` is called.
 */
export class SynthEvents {
    private port: SynthPort | null = null;
    private readonly waiting: SynthMessage[] = [];

    constructor(private readonly convert: SynthConversions) {}

    attach(port: SynthPort): void {
        this.port = port;
        for (const message of this.waiting.splice(0)) {
            port.postMessage(message);
        }
    }

    /** Plays `note` at `time` for `duration`; `velocity` is 0..1. Returns the length in seconds. */
    note(note: string | number, duration: string | number, time: number, velocity = 1): number {
        const seconds = this.convert.seconds(duration);
        this.send({ type: 'note', time, id: 0, frequency: this.convert.frequency(note), velocity, duration: seconds });
        return seconds;
    }

    /** Starts a live note that sounds until `noteOff(id)`. `id` must be above 0. */
    noteOn(id: number, note: string | number, time: number, velocity = 1): void {
        this.send({ type: 'note', time, id, frequency: this.convert.frequency(note), velocity, duration: -1 });
    }

    /** Releases the live note `id` at `time`. */
    noteOff(id: number, time: number): void {
        this.send({ type: 'noteOff', time, id });
    }

    /** Sets a parameter at `time`, or right away. */
    param(name: SynthParamName, value: number, time = 0): void {
        this.send({ type: 'param', time, id: SynthParam[name], value });
    }

    mode(mono: boolean): void {
        this.send({ type: 'mode', mono });
    }

    dispose(): void {
        this.waiting.length = 0;
        this.port?.postMessage({ type: 'dispose' });
        this.port = null;
    }

    private send(message: SynthMessage): void {
        if (this.port) {
            this.port.postMessage(message);
        } else {
            this.waiting.push(message);
        }
    }
}
