import { ref, shallowRef } from 'vue';
import type { AudioWorkerMessage, AudioWorkerStatus } from './audioWorker';
import {
    DEFAULT_PORT,
    PROTOCOL_VERSION,
    type BridgeEvent,
    type BridgeParam,
    type BridgePluginInfo,
    type BridgeResponse,
    type CreateResult,
    type HelloResult,
} from './protocol';

/**
 * The studio's connection to the Juicy Loops Bridge (the desktop app that hosts native plugins): the `/control`
 * WebSocket on the main thread (JSON requests, events from the bridge), the pairing token, and the audio worker
 * that carries the audio (`audioWorker.ts`). One per page (`bridge`); its state is reactive for the UI.
 *
 * It only connects when asked (the plugin browser's desktop section, or a session that uses a desktop plugin): a
 * failed attempt shows up in the browser console, so the studio does not probe for a bridge on every visit.
 */

export type BridgeState = 'idle' | 'connecting' | 'ready' | 'unpaired' | 'offline';

export class BridgeError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'BridgeError';
    }
}

/** The bridge closed or never answered: events for nodes, which then fail or wait. */
export type BridgeClientEvent = BridgeEvent | { event: 'disconnected' } | { event: 'connected' };

export const TOKEN_KEY = 'juicyloops:bridge:token';
export const PORT_KEY = 'juicyloops:bridge:port';

const read = (key: string): string | null => {
    try {
        return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
};

const write = (key: string, value: string | null): void => {
    try {
        if (value === null) {
            globalThis.localStorage?.removeItem(key);
        } else {
            globalThis.localStorage?.setItem(key, value);
        }
    } catch {
        /* not remembered */
    }
};

const REQUEST_TIMEOUT_MS = 20_000;
/** Plugins can take long to load (samples, licence checks). */
const CREATE_TIMEOUT_MS = 90_000;

export const OFFLINE_MESSAGE = 'The Juicy Loops Bridge is not running on this computer.';

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export interface BridgeClientOptions {
    makeSocket?: (url: string) => WebSocket;
    makeWorker?: () => Worker;
}

export class BridgeClient {
    readonly state = ref<BridgeState>('idle');
    readonly message = ref('');
    readonly info = shallowRef<HelloResult | null>(null);
    readonly plugins = shallowRef<BridgePluginInfo[]>([]);
    readonly scanning = ref(false);
    readonly token = ref(read(TOKEN_KEY) ?? '');
    readonly port = ref(Number(read(PORT_KEY)) || DEFAULT_PORT);

    private socket: WebSocket | null = null;
    private connecting: Promise<void> | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly listeners = new Set<(event: BridgeClientEvent) => void>();
    private worker: Worker | null = null;
    private workerOpen: Promise<void> | null = null;
    private readonly makeSocket: (url: string) => WebSocket;
    private readonly makeWorker: () => Worker;
    /** Plugins running on the bridge: while there are any, a lost connection is retried. */
    private users = 0;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private retryDelay = 1000;
    /** Where tempo and play state come from, sent to the bridge when they change (plugins sync LFOs and delays). */
    private transportSource: (() => { bpm: number; playing: boolean }) | null = null;
    private transportTimer: ReturnType<typeof setInterval> | null = null;
    private sentTransport = '';

    constructor(options: BridgeClientOptions = {}) {
        this.makeSocket = options.makeSocket ?? ((url) => new WebSocket(url));
        this.makeWorker =
            options.makeWorker ?? (() => new Worker(new URL('./audioWorker.ts', import.meta.url), { type: 'module', name: 'juicyloops-bridge-audio' }));
    }

    get isReady(): boolean {
        return this.state.value === 'ready';
    }

    /** Connects (once; later calls share the attempt). Rejects with a `BridgeError` (`offline`, `unauthorized`, `protocol`). */
    connect(): Promise<void> {
        if (this.state.value === 'ready' && this.socket) {
            return Promise.resolve();
        }
        this.connecting ??= this.open().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    private open(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.state.value = 'connecting';
            this.message.value = '';
            let socket: WebSocket;
            try {
                socket = this.makeSocket(`ws://127.0.0.1:${this.port.value}/control`);
            } catch {
                this.state.value = 'offline';
                this.message.value = OFFLINE_MESSAGE;
                reject(new BridgeError('offline', OFFLINE_MESSAGE));
                return;
            }
            this.socket = socket;
            let settled = false;
            const fail = (state: BridgeState, code: string, message: string) => {
                this.state.value = state;
                this.message.value = message;
                if (!settled) {
                    settled = true;
                    reject(new BridgeError(code, message));
                }
            };
            socket.onopen = () => {
                const id = this.nextId++;
                this.pending.set(id, {
                    resolve: (result) => {
                        const hello = result as HelloResult;
                        this.info.value = hello;
                        this.state.value = 'ready';
                        this.sentTransport = '';
                        settled = true;
                        resolve();
                        this.emit({ event: 'connected' });
                        void this.refreshPlugins().catch(() => undefined);
                    },
                    reject: (error) => {
                        const code = error instanceof BridgeError ? error.code : 'error';
                        fail(code === 'unauthorized' ? 'unpaired' : 'offline', code, error.message);
                        socket.close();
                    },
                    timer: setTimeout(() => fail('offline', 'offline', 'The bridge did not answer.'), REQUEST_TIMEOUT_MS),
                });
                socket.send(JSON.stringify({ id, type: 'hello', token: this.token.value, protocol: PROTOCOL_VERSION, client: 'juicyloops-studio' }));
            };
            socket.onmessage = (event: MessageEvent<string>) => this.onMessage(event.data);
            socket.onerror = () => {
                /* onclose follows */
            };
            socket.onclose = () => {
                if (this.socket !== socket) {
                    return;
                }
                this.socket = null;
                for (const [id, waiting] of this.pending) {
                    clearTimeout(waiting.timer);
                    waiting.reject(new BridgeError('offline', 'The bridge closed the connection.'));
                    this.pending.delete(id);
                }
                const wasReady = this.state.value === 'ready';
                if (this.state.value !== 'unpaired') {
                    fail('offline', 'offline', wasReady ? 'The bridge was closed.' : OFFLINE_MESSAGE);
                }
                this.closeWorker();
                if (wasReady) {
                    this.emit({ event: 'disconnected' });
                }
                this.scheduleRetry();
            };
        });
    }

    /** A plugin starts using the bridge: keep the connection (and win it back if it drops). */
    retain(): void {
        this.users++;
    }

    release(): void {
        this.users = Math.max(0, this.users - 1);
        if (this.users === 0 && this.retry) {
            clearTimeout(this.retry);
            this.retry = null;
        }
        if (this.users === 0 && this.transportTimer) {
            clearInterval(this.transportTimer);
            this.transportTimer = null;
        }
    }

    /** Keeps the bridge's tempo and play state in step with `source` (checked twice a second while plugins run). */
    watchTransport(source: () => { bpm: number; playing: boolean }): void {
        this.transportSource = source;
        this.sentTransport = '';
        this.transportTimer ??= setInterval(() => this.pushTransport(), 500);
        this.pushTransport();
    }

    private pushTransport(): void {
        if (!this.transportSource || this.state.value !== 'ready' || this.users === 0) {
            return;
        }
        const { bpm, playing } = this.transportSource();
        const key = `${bpm.toFixed(3)}|${playing}`;
        if (key === this.sentTransport) {
            return;
        }
        this.sentTransport = key;
        this.setTransport(bpm, playing).catch(() => {
            this.sentTransport = '';
        });
    }

    /** While plugins use the bridge, try again every few seconds (the bridge may have been restarted). */
    private scheduleRetry(): void {
        if (this.users === 0 || this.retry || this.state.value === 'unpaired') {
            return;
        }
        this.retry = setTimeout(() => {
            this.retry = null;
            this.connect().then(
                () => {
                    this.retryDelay = 1000;
                },
                () => {
                    this.retryDelay = Math.min(10_000, this.retryDelay * 2);
                    this.scheduleRetry();
                },
            );
        }, this.retryDelay);
    }

    private onMessage(text: string): void {
        let message: BridgeResponse | BridgeEvent;
        try {
            message = JSON.parse(text) as BridgeResponse | BridgeEvent;
        } catch {
            return;
        }
        if ('event' in message) {
            if (message.event === 'pluginsChanged') {
                void this.refreshPlugins().catch(() => undefined);
            }
            this.emit(message);
            return;
        }
        const waiting = this.pending.get(message.id);
        if (!waiting) {
            return;
        }
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.ok) {
            waiting.resolve(message.result);
        } else {
            waiting.reject(new BridgeError(message.error?.code ?? 'error', message.error?.message ?? 'The bridge refused.'));
        }
    }

    private emit(event: BridgeClientEvent): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }

    /** Listens to the bridge's events; returns the unsubscribe. */
    onEvent(listener: (event: BridgeClientEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async request<T>(type: string, body: Record<string, unknown> = {}, timeout = REQUEST_TIMEOUT_MS): Promise<T> {
        await this.connect();
        const socket = this.socket;
        if (!socket) {
            throw new BridgeError('offline', OFFLINE_MESSAGE);
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer: setTimeout(() => {
                    this.pending.delete(id);
                    reject(new BridgeError('timeout', 'The bridge took too long to answer.'));
                }, timeout),
            });
            socket.send(JSON.stringify({ ...body, id, type }));
        });
    }

    /** Stores a (new) pairing token and connects with it. */
    async pair(token: string): Promise<void> {
        this.token.value = token.trim();
        write(TOKEN_KEY, this.token.value || null);
        this.disconnect();
        await this.connect();
    }

    setPort(port: number): void {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return;
        }
        this.port.value = port;
        write(PORT_KEY, port === DEFAULT_PORT ? null : String(port));
        this.disconnect();
    }

    disconnect(): void {
        const socket = this.socket;
        this.socket = null;
        socket?.close();
        for (const waiting of this.pending.values()) {
            clearTimeout(waiting.timer);
            waiting.reject(new BridgeError('offline', 'Disconnected.'));
        }
        this.pending.clear();
        this.closeWorker();
        if (this.state.value === 'ready') {
            this.emit({ event: 'disconnected' });
        }
        this.state.value = 'idle';
    }

    async refreshPlugins(rescan = false): Promise<BridgePluginInfo[]> {
        const result = await this.request<{ plugins: BridgePluginInfo[]; scanning: boolean }>('listPlugins', { rescan });
        this.plugins.value = result.plugins;
        this.scanning.value = result.scanning;
        return result.plugins;
    }

    create(body: {
        pluginId: string;
        sampleRate: number;
        maxBlock: number;
        inputChannels: number;
        outputChannels?: number;
        state?: string | null;
        mode: 'live' | 'offline';
    }): Promise<CreateResult> {
        return this.request<CreateResult>('create', { ...body, outputChannels: body.outputChannels ?? 2, state: body.state ?? undefined }, CREATE_TIMEOUT_MS);
    }

    async destroy(instance: number): Promise<void> {
        if (this.isReady) {
            await this.request('destroy', { instance });
        }
    }

    async getState(instance: number): Promise<string> {
        return (await this.request<{ state: string }>('getState', { instance })).state;
    }

    async setState(instance: number, state: string): Promise<void> {
        await this.request('setState', { instance, state });
    }

    async params(instance: number): Promise<BridgeParam[]> {
        return (await this.request<{ params: BridgeParam[] }>('params', { instance })).params;
    }

    async openEditor(instance: number, title?: string): Promise<void> {
        await this.request('openEditor', { instance, title });
    }

    async closeEditor(instance: number): Promise<void> {
        if (this.isReady) {
            await this.request('closeEditor', { instance });
        }
    }

    async setTransport(bpm: number, playing: boolean): Promise<void> {
        if (this.isReady) {
            await this.request('transport', { bpm, playing });
        }
    }

    /** The audio worker, connected to `/audio` (made on first use, again after the bridge closed). */
    private audio(): Promise<Worker> {
        if (!this.worker) {
            const worker = this.makeWorker();
            this.worker = worker;
            this.workerOpen = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new BridgeError('offline', 'The bridge did not open its audio connection.')), 10_000);
                worker.onmessage = (event: MessageEvent<AudioWorkerStatus>) => {
                    if (event.data.type !== 'status') {
                        return;
                    }
                    if (event.data.state === 'open') {
                        clearTimeout(timer);
                        resolve();
                    } else {
                        clearTimeout(timer);
                        reject(
                            new BridgeError(event.data.state === 'refused' ? 'unauthorized' : 'offline', event.data.message ?? 'The audio connection closed.'),
                        );
                        if (this.worker === worker) {
                            this.closeWorker();
                        }
                    }
                };
            });
            this.workerOpen.catch(() => undefined);
            this.post({ type: 'connect', port: this.port.value, token: this.token.value });
        }
        return this.workerOpen!.then(() => this.worker!);
    }

    private post(message: AudioWorkerMessage, transfer: Transferable[] = []): void {
        this.worker?.postMessage(message, transfer);
    }

    private closeWorker(): void {
        if (this.worker) {
            this.post({ type: 'close' });
            this.worker.terminate();
            this.worker = null;
            this.workerOpen = null;
        }
    }

    /** Routes an instance's audio blocks: `port` reaches the worker; its other end is the worklet's (or a renderer's). */
    async attachAudio(instance: number, port: MessagePort): Promise<void> {
        await this.audio();
        this.post({ type: 'attach', instance, port }, [port]);
    }

    detachAudio(instance: number): void {
        this.post({ type: 'detach', instance });
    }
}

export const bridge = new BridgeClient();
