/**
 * The audio end of a plugin on the Juicy Loops Bridge: an AudioWorklet that trades blocks with the desktop app.
 *
 * It cuts the context's timeline into blocks of `blockFrames` and sends each one, with its MIDI events (and, for an
 * effect, its input audio), through a MessagePort to the bridge's audio worker (`audioWorker.ts`), which forwards
 * it over the WebSocket. Processed blocks come back the same way and wait in a jitter buffer until their time:
 *
 * - **instrument**: blocks are requested `aheadFrames` before they are due, so sequenced notes (sent 200 ms early by
 *   the sequencer) land on their exact frame and the plugin adds no audible latency. Live notes (MIDI keyboard)
 *   arrive "now" and play at the start of the next block not yet sent: up to `aheadFrames + blockFrames` late.
 * - **effect**: the input is captured block by block and the processed block plays `delayFrames` after its input
 *   (the effect's added latency; the studio's mixer does not compensate it yet).
 * - **capture**: an effect in an export: only captures (the main thread plays the answers, see `offline.ts`).
 *
 * Buffers circulate instead of being made: requests go out in buffers from a pool made up front, the worker copies
 * each answer into a request buffer it already has and sends that back, and a played block's buffer goes back to
 * the pool. So the audio thread allocates nothing per block but the small message objects `postMessage` needs.
 *
 * No import or export statements at all (see `synthProcessor.ts`): types come in as `import()` type expressions,
 * and the binary layout of `protocol.ts` is repeated below (the tests check that the two agree).
 */
type BridgeProcessorOptions = import('./protocol').BridgeProcessorOptions;
type BridgeWorkletMessage = import('./protocol').BridgeWorkletMessage;

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
    readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions: BridgeProcessorOptions }) => AudioWorkletProcessor): void;

const HEADER = 24;
const EVENT = 8;
const MAX_EVENTS = 64;
const KIND_PROCESS = 1;
const KIND_RESULT = 2;
const KIND_DROPPED = 255;
const STATUS_OK = 0;
const QUANTUM = 128;
/** MIDI events waiting for their block. */
const PENDING = 1024;
/** Blocks received and waiting to play. */
const QUEUE = 128;

interface Packet {
    buffer: ArrayBuffer;
    length: number;
}

class BridgeProcessor extends AudioWorkletProcessor {
    private instance: number;
    private readonly mode: 'instrument' | 'effect' | 'capture';
    private readonly block: number;
    private ahead: number;
    private delay: number;
    private link: MessagePort | null = null;
    private running = true;
    private readonly free: ArrayBuffer[] = [];
    private readonly bufferBytes: number;
    private readonly bufferTarget: number;

    // MIDI events by frame, sorted.
    private readonly eventFrames = new Float64Array(PENDING);
    private readonly eventBytes = new Uint8Array(PENDING * 3);
    private eventCount = 0;

    // Instrument: the next block to ask for.
    private head = -1;
    // Effect: the block being captured.
    private capture: ArrayBuffer | null = null;
    private captureStart = 0;
    private captureFill = 0;

    // Received blocks, oldest first (a ring).
    private readonly queueStart = new Float64Array(QUEUE);
    private readonly queueFrames = new Int32Array(QUEUE);
    private readonly queueChannels = new Int32Array(QUEUE);
    private readonly queuePlayed = new Uint8Array(QUEUE);
    private readonly queueBuffers: (ArrayBuffer | null)[] = new Array<ArrayBuffer | null>(QUEUE).fill(null);
    private readonly queueSamples: (Float32Array | null)[] = new Array<Float32Array | null>(QUEUE).fill(null);
    private queueHead = 0;
    private queueCount = 0;

    // When each block in flight was sent, by its start (a ring searched from the oldest).
    private readonly flightStart = new Float64Array(QUEUE);
    private readonly flightSent = new Float64Array(QUEUE);
    private flightNext = 0;

    private started = false;
    private sent = 0;
    private played = 0;
    private underruns = 0;
    private late = 0;
    private dropped = 0;
    private lateEvents = 0;
    private rttLast = 0;
    private rttMin = Infinity;
    private rttMax = 0;

    constructor(options: { processorOptions: BridgeProcessorOptions }) {
        super();
        const settings = options.processorOptions;
        this.instance = settings.instance;
        this.mode = settings.mode;
        this.block = Math.max(QUANTUM, Math.round(settings.blockFrames / QUANTUM) * QUANTUM);
        this.ahead = Math.max(0, settings.aheadFrames);
        this.delay = Math.max(this.block, settings.delayFrames);
        this.bufferBytes = HEADER + MAX_EVENTS * EVENT + 2 * this.block * 4;
        this.bufferTarget = settings.buffers;
        for (let index = 0; index < settings.buffers; index++) {
            this.free.push(new ArrayBuffer(this.bufferBytes));
        }
        this.port.onmessage = (event: MessageEvent<BridgeWorkletMessage>) => this.onControl(event.data);
    }

    private onControl(message: BridgeWorkletMessage): void {
        switch (message.type) {
            case 'midi':
                this.addEvent(Math.round(message.time * sampleRate), message.bytes);
                break;
            case 'link':
                this.link?.close();
                this.link = message.port;
                this.link.onmessage = (event: MessageEvent<Packet>) => this.onPacket(event.data);
                // A new link after the bridge came back: buffers that were out on the old one are gone.
                while (this.free.length < this.bufferTarget) {
                    this.free.push(new ArrayBuffer(this.bufferBytes));
                }
                break;
            case 'instance':
                this.instance = message.instance;
                break;
            case 'config':
                if (message.aheadFrames !== undefined) {
                    this.ahead = Math.max(0, message.aheadFrames);
                }
                if (message.delayFrames !== undefined) {
                    this.delay = Math.max(this.block, message.delayFrames);
                }
                break;
            case 'stats':
                this.port.postMessage({
                    type: 'stats',
                    sent: this.sent,
                    played: this.played,
                    underruns: this.underruns,
                    late: this.late,
                    dropped: this.dropped,
                    lateEvents: this.lateEvents,
                    roundTrip: { last: this.rttLast, min: this.rttMin === Infinity ? 0 : this.rttMin, max: this.rttMax },
                    aheadFrames: this.ahead,
                    delayFrames: this.delay,
                    blockFrames: this.block,
                });
                break;
            case 'stop':
                this.running = false;
                this.link?.close();
                this.link = null;
                break;
        }
    }

    /** Keeps events sorted by frame; equal frames keep their order (a note-off before the next note-on). */
    private addEvent(frame: number, bytes: readonly number[]): void {
        if (this.eventCount === PENDING) {
            return;
        }
        let at = this.eventCount;
        while (at > 0 && this.eventFrames[at - 1]! > frame) {
            this.eventFrames[at] = this.eventFrames[at - 1]!;
            this.eventBytes[at * 3] = this.eventBytes[(at - 1) * 3]!;
            this.eventBytes[at * 3 + 1] = this.eventBytes[(at - 1) * 3 + 1]!;
            this.eventBytes[at * 3 + 2] = this.eventBytes[(at - 1) * 3 + 2]!;
            at--;
        }
        this.eventFrames[at] = frame;
        this.eventBytes[at * 3] = bytes[0] ?? 0;
        this.eventBytes[at * 3 + 1] = bytes[1] ?? 0;
        this.eventBytes[at * 3 + 2] = bytes[2] ?? 0;
        this.eventCount++;
    }

    /** Writes the events before `end` into the frame (up to the limit) and drops them from the queue. */
    private takeEvents(view: DataView, start: number, end: number): number {
        let count = 0;
        while (count < this.eventCount && count < MAX_EVENTS && this.eventFrames[count]! < end) {
            const frame = this.eventFrames[count]!;
            if (frame < start) {
                this.lateEvents++;
            }
            const at = HEADER + count * EVENT;
            view.setUint16(at, Math.max(0, frame - start), true);
            view.setUint8(at + 2, 3);
            view.setUint8(at + 3, this.eventBytes[count * 3]!);
            view.setUint8(at + 4, this.eventBytes[count * 3 + 1]!);
            view.setUint8(at + 5, this.eventBytes[count * 3 + 2]!);
            view.setUint16(at + 6, 0, true);
            count++;
        }
        if (count > 0) {
            this.eventFrames.copyWithin(0, count, this.eventCount);
            this.eventBytes.copyWithin(0, count * 3, this.eventCount * 3);
            this.eventCount -= count;
        }
        return count;
    }

    private writeHeader(view: DataView, start: number, inChannels: number, events: number): void {
        view.setUint8(0, KIND_PROCESS);
        view.setUint8(1, inChannels);
        view.setUint16(2, this.block, true);
        view.setUint32(4, this.instance, true);
        view.setFloat64(8, start, true);
        view.setUint16(16, events, true);
        view.setUint16(18, 0, true);
        view.setUint32(20, 0, true);
    }

    private send(buffer: ArrayBuffer, length: number, start: number): void {
        if (!this.link) {
            this.free.push(buffer);
            this.dropped++;
            return;
        }
        this.flightStart[this.flightNext] = start;
        this.flightSent[this.flightNext] = currentFrame;
        this.flightNext = (this.flightNext + 1) % QUEUE;
        this.sent++;
        this.link.postMessage({ buffer, length }, [buffer]);
    }

    /** Instrument: asks for every block that starts before `now + quantum + ahead`. */
    private request(now: number): void {
        if (this.head < 0) {
            this.head = now;
        }
        while (this.head < now + QUANTUM + this.ahead) {
            const start = this.head;
            this.head += this.block;
            const buffer = this.free.pop();
            if (!buffer) {
                this.dropped++;
                continue;
            }
            const view = new DataView(buffer);
            const events = this.takeEvents(view, start, start + this.block);
            this.writeHeader(view, start, 0, events);
            this.send(buffer, HEADER + events * EVENT, start);
        }
    }

    /** Effect: copies this quantum's input into the block being captured; sends it when full. */
    private captureInput(input: Float32Array[] | undefined, now: number): void {
        if (!this.capture) {
            const buffer = this.free.pop();
            if (!buffer) {
                this.dropped++;
                return;
            }
            this.capture = buffer;
            this.captureStart = now;
            this.captureFill = 0;
        }
        const samples = new Float32Array(this.capture, HEADER, 2 * this.block);
        const left = input?.[0];
        const right = input?.[1] ?? left;
        if (left) {
            samples.set(left, this.captureFill);
            samples.set(right!, this.block + this.captureFill);
        } else {
            samples.fill(0, this.captureFill, this.captureFill + QUANTUM);
            samples.fill(0, this.block + this.captureFill, this.block + this.captureFill + QUANTUM);
        }
        this.captureFill += QUANTUM;
        if (this.captureFill >= this.block) {
            const buffer = this.capture;
            this.capture = null;
            const view = new DataView(buffer);
            // Effects take no notes; the audio follows the header directly.
            this.writeHeader(view, this.captureStart, 2, 0);
            this.send(buffer, HEADER + 2 * this.block * 4, this.captureStart);
        }
    }

    private onPacket(packet: Packet): void {
        const { buffer, length } = packet;
        if (this.mode === 'capture') {
            // The main thread has played it; the buffer comes home.
            this.free.push(buffer);
            return;
        }
        const view = new DataView(buffer, 0, length);
        const kind = length > 0 ? view.getUint8(0) : KIND_DROPPED;
        if (kind !== KIND_RESULT || length < HEADER) {
            this.free.push(buffer);
            this.dropped++;
            return;
        }
        const start = view.getFloat64(8, true);
        const frames = view.getUint16(2, true);
        const channels = view.getUint8(1);
        const status = view.getUint16(16, true);
        // Round trip, from when the block went out.
        for (let step = 1; step <= QUEUE; step++) {
            const slot = (this.flightNext - step + QUEUE) % QUEUE;
            if (this.flightStart[slot] === start) {
                const trip = currentFrame - this.flightSent[slot]!;
                this.rttLast = trip;
                this.rttMin = Math.min(this.rttMin, trip);
                this.rttMax = Math.max(this.rttMax, trip);
                break;
            }
        }
        const playhead = currentFrame - this.outDelay();
        if (status !== STATUS_OK || channels === 0 || start + frames <= playhead) {
            if (status === STATUS_OK) {
                this.late++;
            }
            this.free.push(buffer);
            return;
        }
        if (this.queueCount === QUEUE) {
            this.recycle();
        }
        // Usually in order: insert from the back.
        let position = this.queueCount;
        while (position > 0 && this.queueStart[(this.queueHead + position - 1) % QUEUE]! > start) {
            const from = (this.queueHead + position - 1) % QUEUE;
            const to = (this.queueHead + position) % QUEUE;
            this.queueStart[to] = this.queueStart[from]!;
            this.queueFrames[to] = this.queueFrames[from]!;
            this.queueChannels[to] = this.queueChannels[from]!;
            this.queuePlayed[to] = this.queuePlayed[from]!;
            this.queueBuffers[to] = this.queueBuffers[from]!;
            this.queueSamples[to] = this.queueSamples[from]!;
            position--;
        }
        const slot = (this.queueHead + position) % QUEUE;
        this.queueStart[slot] = start;
        this.queueFrames[slot] = frames;
        this.queueChannels[slot] = channels;
        this.queuePlayed[slot] = 0;
        this.queueBuffers[slot] = buffer;
        this.queueSamples[slot] = new Float32Array(buffer, HEADER, channels * frames);
        this.queueCount++;
    }

    private outDelay(): number {
        return this.mode === 'effect' ? this.delay : 0;
    }

    /** Drops the oldest received block, its buffer back to the pool. */
    private recycle(): void {
        const slot = this.queueHead;
        if (!this.queuePlayed[slot]) {
            this.late++;
        }
        this.free.push(this.queueBuffers[slot]!);
        this.queueBuffers[slot] = null;
        this.queueSamples[slot] = null;
        this.queueHead = (this.queueHead + 1) % QUEUE;
        this.queueCount--;
    }

    private play(left: Float32Array, right: Float32Array | undefined, now: number): void {
        const delay = this.outDelay();
        // Gaps before the first sound are the start-up, not underruns.
        const playing = this.started;
        let index = 0;
        let gap = false;
        while (index < QUANTUM) {
            const time = now + index - delay;
            while (this.queueCount > 0 && this.queueStart[this.queueHead]! + this.queueFrames[this.queueHead]! <= time) {
                this.recycle();
            }
            if (this.queueCount > 0 && this.queueStart[this.queueHead]! <= time) {
                const slot = this.queueHead;
                const start = this.queueStart[slot]!;
                const frames = this.queueFrames[slot]!;
                const samples = this.queueSamples[slot]!;
                const offset = time - start;
                const count = Math.min(QUANTUM - index, frames - offset);
                left.set(samples.subarray(offset, offset + count), index);
                if (right) {
                    const second = this.queueChannels[slot]! > 1 ? frames : 0;
                    right.set(samples.subarray(second + offset, second + offset + count), index);
                }
                if (!this.queuePlayed[slot]) {
                    this.queuePlayed[slot] = 1;
                    this.played++;
                    this.started = true;
                }
                index += count;
            } else {
                const next = this.queueCount > 0 ? this.queueStart[this.queueHead]! : Infinity;
                const count = Math.min(QUANTUM - index, next - time);
                left.fill(0, index, index + count);
                right?.fill(0, index, index + count);
                gap = true;
                index += count;
            }
        }
        if (gap && playing) {
            this.underruns++;
        }
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        if (!this.running) {
            return false;
        }
        const now = currentFrame;
        if (this.mode === 'instrument') {
            this.request(now);
        } else {
            this.captureInput(inputs[0], now);
        }
        const output = outputs[0];
        if (output?.[0] && this.mode !== 'capture') {
            this.play(output[0], output[1], now);
        }
        return true;
    }
}

registerProcessor('juicyloops-bridge', BridgeProcessor);
