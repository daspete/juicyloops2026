/**
 * The bridge's audio worker: owns the `/audio` WebSocket and relays blocks between it and each plugin's
 * AudioWorklet (or, in an export, the main thread), so audio never waits for the busy main thread.
 *
 * Every instance attaches a MessagePort. A request comes in as `{ buffer, length }`; it goes out on the socket and
 * its buffer is kept as a spare of that instance. An answer from the socket is copied into a spare and that goes
 * back, so the worklet gets its own buffers back and never has to make new ones. Render chunks (bigger, exports
 * only) go back as they came.
 */
import { DEFAULT_PORT, KIND_DROPPED, KIND_RENDER_RESULT, PROTOCOL_VERSION, instanceOf, kindOf } from './protocol';

export type AudioWorkerMessage =
    | { type: 'connect'; port: number; token: string }
    | { type: 'attach'; instance: number; port: MessagePort }
    | { type: 'detach'; instance: number }
    | { type: 'close' };

export type AudioWorkerStatus = { type: 'status'; state: 'open' | 'closed' | 'refused'; message?: string };

interface Packet {
    buffer: ArrayBuffer;
    length: number;
}

interface Attached {
    port: MessagePort;
    spares: ArrayBuffer[];
}

/** The relay itself, apart from the worker globals so tests can drive it. */
export class AudioRelay {
    private socket: WebSocket | null = null;
    private open = false;
    private readonly instances = new Map<number, Attached>();
    private settings: { port: number; token: string } = { port: DEFAULT_PORT, token: '' };

    constructor(
        private readonly post: (message: AudioWorkerStatus) => void,
        private readonly makeSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
    ) {}

    handle(message: AudioWorkerMessage): void {
        switch (message.type) {
            case 'connect':
                this.settings = { port: message.port, token: message.token };
                this.connect();
                break;
            case 'attach': {
                const attached: Attached = { port: message.port, spares: [] };
                message.port.onmessage = (event: MessageEvent<Packet | ArrayBuffer>) => this.fromInstance(attached, event.data);
                this.instances.get(message.instance)?.port.close();
                this.instances.set(message.instance, attached);
                break;
            }
            case 'detach':
                this.instances.get(message.instance)?.port.close();
                this.instances.delete(message.instance);
                break;
            case 'close':
                this.socket?.close();
                this.socket = null;
                this.open = false;
                break;
        }
    }

    private connect(): void {
        this.socket?.close();
        this.open = false;
        const socket = this.makeSocket(`ws://127.0.0.1:${this.settings.port}/audio`);
        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        socket.onopen = () =>
            socket.send(JSON.stringify({ id: 1, type: 'hello', token: this.settings.token, protocol: PROTOCOL_VERSION, client: 'juicyloops-studio' }));
        socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
            if (typeof event.data === 'string') {
                const answer = JSON.parse(event.data) as { ok?: boolean; error?: { message?: string } };
                if (answer.ok) {
                    this.open = true;
                    this.post({ type: 'status', state: 'open' });
                } else {
                    this.post({ type: 'status', state: 'refused', message: answer.error?.message });
                }
                return;
            }
            this.fromSocket(event.data);
        };
        socket.onclose = () => {
            if (this.socket === socket) {
                this.open = false;
                this.socket = null;
                this.post({ type: 'status', state: 'closed' });
            }
        };
    }

    /** A request from an instance (`{buffer, length}`), or a whole render request (an ArrayBuffer). */
    private fromInstance(attached: Attached, data: Packet | ArrayBuffer): void {
        if (data instanceof ArrayBuffer) {
            if (this.open && this.socket) {
                this.socket.send(data);
            }
            return;
        }
        const { buffer, length } = data;
        if (!this.open || !this.socket) {
            // Back unsent, marked, so the worklet's pool does not run dry.
            new DataView(buffer).setUint8(0, KIND_DROPPED);
            attached.port.postMessage({ buffer, length: 1 }, [buffer]);
            return;
        }
        // `send` copies, so the buffer is free again right away.
        this.socket.send(new Uint8Array(buffer, 0, length));
        attached.spares.push(buffer);
    }

    private fromSocket(data: ArrayBuffer): void {
        const attached = this.instances.get(instanceOf(data));
        if (!attached) {
            return;
        }
        if (kindOf(data) === KIND_RENDER_RESULT) {
            attached.port.postMessage(data, [data]);
            return;
        }
        let spare = attached.spares.pop();
        if (!spare || spare.byteLength < data.byteLength) {
            spare = new ArrayBuffer(Math.max(data.byteLength, spare?.byteLength ?? 0));
        }
        new Uint8Array(spare).set(new Uint8Array(data));
        attached.port.postMessage({ buffer: spare, length: data.byteLength }, [spare]);
    }
}

// In a worker: wire the relay to the worker's own messages.
const scope = globalThis as unknown as { postMessage?: (message: unknown) => void; onmessage?: unknown; WorkerGlobalScope?: unknown };
if (typeof scope.WorkerGlobalScope !== 'undefined' && typeof scope.postMessage === 'function') {
    const relay = new AudioRelay((message) => scope.postMessage!(message));
    scope.onmessage = (event: MessageEvent<AudioWorkerMessage>) => relay.handle(event.data);
}
