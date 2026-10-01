/**
 * The recorder worklet of a real-time export (`liveRender.ts`): it listens to the master output and keeps an exact
 * stretch of it, frame by frame, from the frame the transport starts on. The recording goes to the main thread in
 * chunks (their buffers transferred, not copied), so the audio thread never holds more than one chunk.
 *
 * Loaded like `synthProcessor.ts` (`?worker&url`, `addAudioWorkletModule`) and bound by the same rule: no import or
 * export statements at all, not even `import type`, because standardized-audio-context wraps this source in a
 * function and the dev server turns an elided type import into `export {}`. Types come in as `import()` expressions.
 */
type RecorderCommand = import('./recorderProtocol').RecorderCommand;
type RecorderEvent = import('./recorderProtocol').RecorderEvent;

declare const currentFrame: number;
declare class AudioWorkletProcessor {
    readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

/** Frames per chunk: about a third of a second at 48 kHz, few enough messages and small enough to hand over quickly. */
const CHUNK = 16384;

class RecorderProcessor extends AudioWorkletProcessor {
    /** The first frame to keep, and how many; `armed` while a recording is running. */
    private start = 0;
    private frames = 0;
    private isArmed = false;
    /** Frames recorded so far, and the chunk being filled. */
    private written = 0;
    private left = new Float32Array(CHUNK);
    private right = new Float32Array(CHUNK);
    private filled = 0;
    private isDisposed = false;

    constructor() {
        super();
        this.port.onmessage = (event: MessageEvent<RecorderCommand>) => this.receive(event.data);
    }

    private receive(command: RecorderCommand): void {
        switch (command.type) {
            case 'record':
                this.start = Math.round(command.frame);
                this.frames = Math.max(0, Math.round(command.frames));
                this.written = 0;
                this.filled = 0;
                this.isArmed = true;
                if (this.frames === 0) {
                    this.finish();
                }
                break;
            case 'cancel':
                this.isArmed = false;
                break;
            case 'dispose':
                this.isArmed = false;
                this.isDisposed = true;
                this.port.onmessage = null;
                break;
        }
    }

    private post(event: RecorderEvent, transfer: Transferable[] = []): void {
        this.port.postMessage(event, transfer);
    }

    /** Sends the chunk filled so far (only its filled part) and starts a new one. */
    private flush(): void {
        if (this.filled === 0) {
            return;
        }
        const full = this.filled === CHUNK;
        const left = full ? this.left : this.left.slice(0, this.filled);
        const right = full ? this.right : this.right.slice(0, this.filled);
        this.post({ type: 'chunk', offset: this.written - this.filled, left, right }, [left.buffer, right.buffer]);
        this.left = new Float32Array(CHUNK);
        this.right = new Float32Array(CHUNK);
        this.filled = 0;
    }

    private finish(): void {
        this.flush();
        this.isArmed = false;
        this.post({ type: 'done', frames: this.written });
    }

    /**
     * Copies the part of this block that falls inside the recording. A block without input (nothing connected yet,
     * or the graph around it idle) counts as silence, so the frame count always follows the clock. A mono input
     * goes to both sides. Returns true while the node exists: it has no outputs, and the browser keeps pulling it.
     */
    process(inputs: Float32Array[][]): boolean {
        if (this.isDisposed) {
            return false;
        }
        if (!this.isArmed) {
            return true;
        }
        const input = inputs[0];
        const inLeft = input?.[0];
        const inRight = input?.[1] ?? inLeft;
        const size = inLeft?.length ?? 128;
        const blockStart = currentFrame;
        const next = this.start + this.written;
        if (next < blockStart) {
            // The frame to start on has already played: the command came too late. A gap would shift everything after it.
            this.isArmed = false;
            this.post({ type: 'late', missed: blockStart - next });
            return true;
        }
        let index = next - blockStart;
        while (index < size && this.written < this.frames) {
            const count = Math.min(size - index, this.frames - this.written, CHUNK - this.filled);
            if (inLeft && inRight) {
                this.left.set(inLeft.subarray(index, index + count), this.filled);
                this.right.set(inRight.subarray(index, index + count), this.filled);
            }
            // Without input the fresh chunk's zeros stay: silence.
            this.filled += count;
            this.written += count;
            index += count;
            if (this.filled === CHUNK) {
                this.flush();
            }
        }
        if (this.written >= this.frames) {
            this.finish();
        }
        return true;
    }
}

registerProcessor('juicyloops-recorder', RecorderProcessor);
