/**
 * The synth worklet: one per synth track, all of the track's voices summed (in stereo) inside `synth-worklet.wasm` (Rust,
 * `juicyloops/dsp/crates/synth-worklet`). Loaded by `SynthVoices.ts` with `addAudioWorkletModule`; Vite bundles it
 * as a worker script (`?worker&url`).
 *
 * The main thread sends notes and parameter changes stamped with context time (`synthProtocol.ts`); they become
 * absolute frames here and the engine applies them on exactly that frame. The WebAssembly module arrives compiled
 * in `processorOptions`, so instantiating it here is synchronous.
 *
 * No import or export statements at all, not even `import type`: standardized-audio-context wraps this source in a
 * function when it registers it, and the dev server's TypeScript transform turns an elided type import into
 * `export {}`, which is a syntax error there. Types come in as `import()` type expressions instead.
 */
type SynthMessage = import('./synthProtocol').SynthMessage;
type SynthProcessorOptions = import('./synthProtocol').SynthProcessorOptions;

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
    readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions: SynthProcessorOptions }) => AudioWorkletProcessor): void;

interface SynthExports {
    memory: WebAssembly.Memory;
    abi_version(): number;
    init(sampleRate: number, kind: number): void;
    out_ptr(): number;
    note_on(frame: number, id: number, frequency: number, velocity: number, durationFrames: number): number;
    note_off(frame: number, id: number): number;
    set_param(frame: number, id: number, value: number): number;
    set_mode(mono: number): void;
    process(startFrame: number, frames: number): number;
}

/** Frames the engine renders per call at most (`MAX_BLOCK`). The out buffer holds that many for each side. */
const BLOCK = 128;

class SynthProcessor extends AudioWorkletProcessor {
    private readonly wasm: SynthExports;
    private readonly left: Float32Array;
    private readonly right: Float32Array;
    /** Whether the engine may make sound: false once it reported silence, until the next message. */
    private isBusy = false;
    private isDisposed = false;

    constructor({ processorOptions }: { processorOptions: SynthProcessorOptions }) {
        super();
        const wasm = new WebAssembly.Instance(processorOptions.module, {}).exports as unknown as SynthExports;
        const abi = wasm.abi_version();
        if (abi !== processorOptions.abi) {
            throw new Error(`synth-worklet.wasm speaks ABI ${abi}, expected ${processorOptions.abi}`);
        }
        wasm.init(sampleRate, processorOptions.kind ?? 0);
        this.wasm = wasm;
        // The engine allocates only in `init`, so memory never grows and these views stay valid.
        this.left = new Float32Array(wasm.memory.buffer, wasm.out_ptr(), BLOCK);
        this.right = new Float32Array(wasm.memory.buffer, wasm.out_ptr() + BLOCK * 4, BLOCK);
        this.port.onmessage = (event: MessageEvent<SynthMessage>) => this.receive(event.data);
    }

    private receive(message: SynthMessage): void {
        const frame = (time: number) => Math.round(time * sampleRate);
        switch (message.type) {
            case 'note':
                // A negative duration holds a live note until its `noteOff`.
                this.wasm.note_on(frame(message.time), message.id, message.frequency, message.velocity, message.duration < 0 ? -1 : frame(message.duration));
                break;
            case 'noteOff':
                this.wasm.note_off(frame(message.time), message.id);
                break;
            case 'param':
                this.wasm.set_param(frame(message.time), message.id, message.value);
                break;
            case 'mode':
                this.wasm.set_mode(message.mono ? 1 : 0);
                break;
            case 'dispose':
                this.isDisposed = true;
                this.port.onmessage = null;
                break;
        }
        this.isBusy = true;
    }

    /**
     * Returning true keeps the node running while it exists (it has no inputs, so false would silence it for good);
     * a silent engine costs one fill per block. After `dispose` it returns false and the browser lets it go.
     */
    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        if (this.isDisposed) {
            return false;
        }
        const channel = outputs[0]?.[0];
        if (!channel) {
            return true;
        }
        const right = outputs[0]?.[1];
        if (!this.isBusy) {
            channel.fill(0);
            right?.fill(0);
            return true;
        }
        let busy = 0;
        for (let offset = 0; offset < channel.length; offset += BLOCK) {
            const frames = Math.min(BLOCK, channel.length - offset);
            busy = this.wasm.process(currentFrame + offset, frames);
            channel.set(this.left.subarray(0, frames), offset);
            right?.set(this.right.subarray(0, frames), offset);
        }
        this.isBusy = busy > 0;
        return true;
    }
}

registerProcessor('juicyloops-synth', SynthProcessor);
