import { FrequencyClass, getContext, ToneAudioNode, type BaseContext } from 'tone';
import type { OscillatorType } from '../notes';
import type { SynthEnvelope, SynthEnvelopeParam } from '../tracks/synthEngine';
import { SYNTH_ABI, SYNTH_PROCESSOR, SynthEvents, WAVEFORMS, type SynthProcessorOptions } from './synthProtocol';
// Vite bundles the processor as a worker script (a hashed asset in the build) and emits the module as a hashed asset.
import synthProcessorUrl from './synthProcessor.ts?worker&url';
import synthWasmUrl from './wasm/synth-worklet.wasm?url';

/**
 * The Rust synth (`juicyloops/dsp`, step 2.2 of notes/performance-upgrade.md): every voice of a track in one
 * AudioWorklet node, replacing Tone's `Synth`/`PolySynth` and their dozen nodes per voice.
 *
 * A `ToneAudioNode`, so it connects like any Tone node. The worklet node is built as soon as the WebAssembly module
 * is compiled (once per page) and the processor is registered on the node's context (once per context, including
 * each offline render's); notes and changes sent before that wait and go out in order. `whenReady` resolves once
 * the node exists, which is what an offline render waits for.
 */

export interface SynthVoicesOptions {
    context: BaseContext;
    cutsNotes: boolean;
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
    /** Called when the worklet cannot be built after all; the owner switches to another engine. */
    onFailure?: (error: unknown) => void;
}

/** The compiled module, shared by every node and context (a `WebAssembly.Module` is structured-cloneable). */
let compiling: Promise<WebAssembly.Module> | null = null;
let compiled: WebAssembly.Module | null = null;
/** Contexts the processor is registered on, and those still registering. */
const registering = new WeakMap<BaseContext, Promise<void>>();
const registered = new WeakSet<BaseContext>();
/** Set when the module or the worklet failed once; every engine built afterwards is the fallback. */
let failure: unknown = null;

const compile = (): Promise<WebAssembly.Module> =>
    (compiling ??= (async () => {
        const response = await fetch(synthWasmUrl);
        if (!response.ok) {
            throw new Error(`Could not fetch the synth engine (${response.status})`);
        }
        // Streaming needs the `application/wasm` type; anything else compiles from the bytes.
        const module =
            response.headers.get('content-type') === 'application/wasm'
                ? await WebAssembly.compileStreaming(response)
                : await WebAssembly.compile(await response.arrayBuffer());
        compiled = module;
        return module;
    })());

const register = (context: BaseContext): Promise<void> => {
    let promise = registering.get(context);
    if (!promise) {
        promise = context.addAudioWorkletModule(synthProcessorUrl).then(() => {
            registered.add(context);
        });
        registering.set(context, promise);
    }
    return promise;
};

/**
 * Whether the worklet engine can run on a context: AudioWorklet needs a secure origin (the plain-http dev host
 * has none), and nothing failed before.
 */
export const isSynthWorkletUsable = (context: BaseContext): boolean =>
    failure === null && typeof WebAssembly !== 'undefined' && (context.rawContext as { audioWorklet?: unknown }).audioWorklet !== undefined;

/** Note names repeat all the time; parsing them once is enough. */
const frequencies = new Map<string, number>();

/** A note name ('A4', 'C#5') or a frequency, in Hz, as Tone reads it. */
export const noteFrequency = (note: string | number): number => {
    if (typeof note === 'number') {
        return note;
    }
    let hz = frequencies.get(note);
    if (hz === undefined) {
        hz = new FrequencyClass(getContext(), note).toFrequency();
        frequencies.set(note, hz);
    }
    return hz;
};

export class SynthVoices extends ToneAudioNode {
    readonly name: string = 'SynthVoices';
    readonly input = undefined;
    readonly output: GainNode;

    private node: AudioWorkletNode | null = null;
    private readonly events: SynthEvents;
    private readonly ready: Promise<void>;
    private isDisposed = false;

    constructor({ context, cutsNotes, oscillatorType, envelope, onFailure }: SynthVoicesOptions) {
        super({ context });
        this.output = this.context.createGain();
        this.events = new SynthEvents({
            frequency: noteFrequency,
            // The node's own context and transport: an offline render has its own tempo.
            seconds: (duration) => this.toSeconds(duration),
        });
        this.events.mode(cutsNotes);
        this.setOscillatorType(oscillatorType);
        for (const param of Object.keys(envelope) as SynthEnvelopeParam[]) {
            this.events.param(param, envelope[param]);
        }
        this.ready = this.build(onFailure);
    }

    /** Plays a note at `time`; returns its length in seconds. */
    triggerAttackRelease(note: string | number, duration: string | number, time: number, velocity = 1): number {
        return this.events.note(note, duration, time, velocity);
    }

    setCutsNotes(cuts: boolean): void {
        this.events.mode(cuts);
    }

    setOscillatorType(type: OscillatorType): void {
        this.events.param('waveform', WAVEFORMS[type] ?? WAVEFORMS.sine);
    }

    /** With a `time`, the engine applies the change on that very frame. */
    setEnvelope(param: SynthEnvelopeParam, value: number, time?: number): void {
        this.events.param(param, value, time);
    }

    whenReady(): Promise<void> {
        return this.ready;
    }

    dispose(): this {
        super.dispose();
        this.isDisposed = true;
        this.events.dispose();
        this.node?.disconnect();
        this.node = null;
        return this;
    }

    private async build(onFailure: SynthVoicesOptions['onFailure']): Promise<void> {
        try {
            // A woken track (hibernation) usually finds both ready and builds its node right away.
            const module = compiled && registered.has(this.context) ? compiled : (await Promise.all([compile(), register(this.context)]))[0];
            if (!this.isDisposed) {
                this.createNode(module, onFailure);
            }
        } catch (error) {
            this.fail(error, onFailure);
        }
    }

    private createNode(module: WebAssembly.Module, onFailure: SynthVoicesOptions['onFailure']): void {
        const processorOptions: SynthProcessorOptions = { module, abi: SYNTH_ABI };
        const node = this.context.createAudioWorkletNode(SYNTH_PROCESSOR, {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions,
        });
        node.onprocessorerror = (event) => this.fail(event, onFailure);
        node.connect(this.output);
        this.node = node;
        this.events.attach(node.port);
    }

    private fail(error: unknown, onFailure: SynthVoicesOptions['onFailure']): void {
        if (failure === null) {
            console.warn('The synth engine could not start; synth tracks play with the Tone.js engine instead.', error);
        }
        failure = error ?? new Error('synth worklet failed');
        // Never from inside the constructor (a woken track builds its node there): the owner has not stored this engine yet.
        queueMicrotask(() => {
            if (!this.isDisposed) {
                onFailure?.(error);
            }
        });
    }
}
