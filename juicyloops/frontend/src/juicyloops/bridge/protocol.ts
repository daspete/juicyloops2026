/**
 * The wire protocol of the Juicy Loops Bridge (the desktop app in `juicyloops/vst-bridge`, which hosts native CLAP
 * and VST3 plugins). The full description is `juicyloops/vst-bridge/PROTOCOL.md`; the Rust side is
 * `vst-bridge/src/protocol.rs`. Kept free of browser and Vue APIs so the worker, the main thread and tests share it.
 *
 * `bridgeProcessor.ts` (the AudioWorklet) cannot import anything and repeats the binary layout; the tests check
 * both against each other.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47817;

/** How a plugin is named in a `PluginRef.url`: `vstbridge:<bridge plugin id>`, e.g. `vstbridge:clap:com.u-he.diva`. */
export const BRIDGE_SCHEME = 'vstbridge:';

export const isBridgeUrl = (url: string): boolean => url.startsWith(BRIDGE_SCHEME);

export const bridgeUrl = (pluginId: string): string => `${BRIDGE_SCHEME}${pluginId}`;

export const pluginIdOf = (url: string): string => url.slice(BRIDGE_SCHEME.length);

/* ---------------------------------------------------------------- control (JSON) */

export type BridgePluginFormat = 'clap' | 'vst3' | 'builtin';
export type BridgePluginKind = 'instrument' | 'effect';

export interface BridgePluginInfo {
    id: string;
    format: BridgePluginFormat;
    nativeId: string;
    name: string;
    vendor: string;
    version: string;
    kind: BridgePluginKind;
    categories: string[];
    path: string;
}

export interface HelloResult {
    bridge: string;
    version: string;
    protocol: number;
    os: string;
    formats: string[];
    /** Whether the bridge can show plugin windows (it has a display). */
    editors: boolean;
}

export interface CreateResult {
    instance: number;
    plugin: BridgePluginInfo;
    /** Frames of latency the plugin reports. */
    latency: number;
    hasEditor: boolean;
    inputChannels: number;
    outputChannels: number;
    maxBlock: number;
}

export interface BridgeParam {
    id: number;
    name: string;
    module: string;
    min: number;
    max: number;
    default: number;
    value: number;
    automatable: boolean;
}

export type BridgeEvent =
    | { event: 'editorClosed'; instance: number }
    | { event: 'stateChanged'; instance: number }
    | { event: 'latencyChanged'; instance: number; latency: number }
    | { event: 'pluginsChanged' };

export interface BridgeResponse {
    id: number;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
}

/** What a bridge plugin keeps in `PluginRef.state`: the plugin's own chunk, base64. */
export interface BridgePluginState {
    format: 'vstbridge';
    chunk: string;
}

export const isBridgeState = (value: unknown): value is BridgePluginState =>
    !!value && typeof value === 'object' && (value as BridgePluginState).format === 'vstbridge' && typeof (value as BridgePluginState).chunk === 'string';

/* ---------------------------------------------------------------- audio (binary) */

export const KIND_PROCESS = 1;
export const KIND_RESULT = 2;
export const KIND_RENDER = 3;
export const KIND_RENDER_RESULT = 4;
/** Not on the wire: the worker hands a request buffer back unsent (no connection). */
export const KIND_DROPPED = 255;

export const HEADER_SIZE = 24;
export const EVENT_SIZE = 8;

export const STATUS_OK = 0;
export const STATUS_NO_INSTANCE = 1;
export const STATUS_PLUGIN_ERROR = 2;
export const STATUS_BAD_REQUEST = 3;

export const RENDER_LAST = 1;
export const RENDER_ERROR = 2;

/** Most events one block carries; more wait for the next block. */
export const MAX_BLOCK_EVENTS = 64;

/** Bytes of a `PROCESS` frame with room for `MAX_BLOCK_EVENTS` and two channels of `frames`. */
export const processBufferSize = (frames: number): number => HEADER_SIZE + MAX_BLOCK_EVENTS * EVENT_SIZE + 2 * frames * 4;

export interface MidiEventAt {
    /** Frame in the block (`PROCESS`) or in the render (`RENDER`). */
    frame: number;
    bytes: readonly [number, number, number] | readonly number[];
}

/** Writes a `PROCESS` frame into `buffer`; returns its length. `input` holds `inChannels` planar channels. */
export const encodeProcess = (
    buffer: ArrayBuffer,
    instance: number,
    startFrame: number,
    frames: number,
    events: readonly MidiEventAt[],
    input: readonly Float32Array[] = [],
): number => {
    const view = new DataView(buffer);
    const count = Math.min(events.length, MAX_BLOCK_EVENTS);
    view.setUint8(0, KIND_PROCESS);
    view.setUint8(1, input.length);
    view.setUint16(2, frames, true);
    view.setUint32(4, instance, true);
    view.setFloat64(8, startFrame, true);
    view.setUint16(16, count, true);
    view.setUint16(18, 0, true);
    view.setUint32(20, 0, true);
    for (let index = 0; index < count; index++) {
        const at = HEADER_SIZE + index * EVENT_SIZE;
        const event = events[index]!;
        view.setUint16(at, event.frame, true);
        view.setUint8(at + 2, 3);
        view.setUint8(at + 3, event.bytes[0] ?? 0);
        view.setUint8(at + 4, event.bytes[1] ?? 0);
        view.setUint8(at + 5, event.bytes[2] ?? 0);
        view.setUint16(at + 6, 0, true);
    }
    const audioAt = HEADER_SIZE + count * EVENT_SIZE;
    const samples = new Float32Array(buffer, audioAt, input.length * frames);
    input.forEach((channel, index) => samples.set(channel.subarray(0, frames), index * frames));
    return audioAt + input.length * frames * 4;
};

export interface ProcessFrame {
    instance: number;
    startFrame: number;
    frames: number;
    inChannels: number;
    events: MidiEventAt[];
    /** Planar input, a view into the frame. */
    input: Float32Array;
}

/** Reads a `PROCESS` frame (the bridge does this in Rust; here for tests and tools). */
export const decodeProcess = (buffer: ArrayBuffer, length = buffer.byteLength): ProcessFrame => {
    const view = new DataView(buffer, 0, length);
    if (length < HEADER_SIZE || view.getUint8(0) !== KIND_PROCESS) {
        throw new Error('Not a process frame');
    }
    const inChannels = view.getUint8(1);
    const frames = view.getUint16(2, true);
    const count = view.getUint16(16, true);
    const events: MidiEventAt[] = [];
    for (let index = 0; index < count; index++) {
        const at = HEADER_SIZE + index * EVENT_SIZE;
        events.push({ frame: view.getUint16(at, true), bytes: [view.getUint8(at + 3), view.getUint8(at + 4), view.getUint8(at + 5)] });
    }
    return {
        instance: view.getUint32(4, true),
        startFrame: view.getFloat64(8, true),
        frames,
        inChannels,
        events,
        input: new Float32Array(buffer, HEADER_SIZE + count * EVENT_SIZE, inChannels * frames),
    };
};

/** Writes a `RESULT` frame into `buffer` (what the bridge answers; for tests and tools). Returns its length. */
export const encodeResult = (
    buffer: ArrayBuffer,
    instance: number,
    startFrame: number,
    frames: number,
    output: readonly Float32Array[],
    status = STATUS_OK,
    micros = 0,
): number => {
    const view = new DataView(buffer);
    view.setUint8(0, KIND_RESULT);
    view.setUint8(1, status === STATUS_OK ? output.length : 0);
    view.setUint16(2, frames, true);
    view.setUint32(4, instance, true);
    view.setFloat64(8, startFrame, true);
    view.setUint16(16, status, true);
    view.setUint16(18, 0, true);
    view.setUint32(20, micros, true);
    if (status !== STATUS_OK) {
        return HEADER_SIZE;
    }
    const samples = new Float32Array(buffer, HEADER_SIZE, output.length * frames);
    output.forEach((channel, index) => samples.set(channel.subarray(0, frames), index * frames));
    return HEADER_SIZE + output.length * frames * 4;
};

export interface ResultFrame {
    instance: number;
    startFrame: number;
    frames: number;
    outChannels: number;
    status: number;
    micros: number;
    /** Planar output (`outChannels × frames`), a view into the frame. */
    output: Float32Array;
}

export const decodeResult = (buffer: ArrayBuffer, length = buffer.byteLength): ResultFrame => {
    const view = new DataView(buffer, 0, length);
    if (length < HEADER_SIZE || view.getUint8(0) !== KIND_RESULT) {
        throw new Error('Not a result frame');
    }
    const outChannels = view.getUint8(1);
    const frames = view.getUint16(2, true);
    const status = view.getUint16(16, true);
    return {
        instance: view.getUint32(4, true),
        startFrame: view.getFloat64(8, true),
        frames,
        outChannels,
        status,
        micros: view.getUint32(20, true),
        output: new Float32Array(buffer, HEADER_SIZE, status === STATUS_OK ? outChannels * frames : 0),
    };
};

/** A `RENDER` request: the whole range at once (an instrument in an export). */
export const encodeRender = (
    instance: number,
    frames: number,
    events: readonly MidiEventAt[],
    input: readonly Float32Array[] = [],
    chunkUnits = 64,
): ArrayBuffer => {
    const buffer = new ArrayBuffer(HEADER_SIZE + events.length * EVENT_SIZE + input.length * frames * 4);
    const view = new DataView(buffer);
    view.setUint8(0, KIND_RENDER);
    view.setUint8(1, input.length);
    view.setUint16(2, chunkUnits, true);
    view.setUint32(4, instance, true);
    view.setFloat64(8, frames, true);
    view.setUint32(16, events.length, true);
    view.setUint32(20, 0, true);
    events.forEach((event, index) => {
        const at = HEADER_SIZE + index * EVENT_SIZE;
        view.setUint32(at, event.frame, true);
        view.setUint8(at + 4, event.bytes[0] ?? 0);
        view.setUint8(at + 5, event.bytes[1] ?? 0);
        view.setUint8(at + 6, event.bytes[2] ?? 0);
        view.setUint8(at + 7, 3);
    });
    const samples = new Float32Array(buffer, HEADER_SIZE + events.length * EVENT_SIZE, input.length * frames);
    input.forEach((channel, index) => samples.set(channel.subarray(0, frames), index * frames));
    return buffer;
};

export interface RenderChunk {
    instance: number;
    startFrame: number;
    frames: number;
    outChannels: number;
    last: boolean;
    error: string | null;
    output: Float32Array;
}

export const decodeRenderResult = (buffer: ArrayBuffer): RenderChunk => {
    const view = new DataView(buffer);
    if (buffer.byteLength < HEADER_SIZE || view.getUint8(0) !== KIND_RENDER_RESULT) {
        throw new Error('Not a render result frame');
    }
    const flags = view.getUint32(20, true);
    const outChannels = view.getUint8(1);
    const frames = view.getUint32(16, true);
    const error = flags & RENDER_ERROR ? new TextDecoder().decode(new Uint8Array(buffer, HEADER_SIZE)) : null;
    return {
        instance: view.getUint32(4, true),
        startFrame: view.getFloat64(8, true),
        frames,
        outChannels,
        last: (flags & RENDER_LAST) !== 0,
        error,
        output: error ? new Float32Array(0) : new Float32Array(buffer, HEADER_SIZE, outChannels * frames),
    };
};

/** The instance a binary frame is about (every kind keeps it at byte 4). */
export const instanceOf = (buffer: ArrayBuffer): number => (buffer.byteLength >= 8 ? new DataView(buffer).getUint32(4, true) : 0);

export const kindOf = (buffer: ArrayBuffer): number => (buffer.byteLength >= 1 ? new DataView(buffer).getUint8(0) : 0);

/* ---------------------------------------------------------------- worklet messages */

/** Main thread → bridge worklet (`node.port`). Times are context seconds. */
export type BridgeWorkletMessage =
    | { type: 'midi'; time: number; bytes: [number, number, number] }
    | { type: 'link'; port: MessagePort }
    | { type: 'instance'; instance: number }
    | { type: 'config'; aheadFrames?: number; delayFrames?: number }
    | { type: 'stats' }
    | { type: 'stop' };

/** Bridge worklet → main thread. */
export interface BridgeWorkletStats {
    type: 'stats';
    /** Blocks sent and played. */
    sent: number;
    played: number;
    /** Output quanta with a missing block (heard as a gap). */
    underruns: number;
    /** Blocks that arrived too late to play. */
    late: number;
    /** Blocks not sent: no buffer free or no connection. */
    dropped: number;
    /** Events that came after their block had gone (played at its start instead). */
    lateEvents: number;
    /** Round trip of a block in frames (128-frame resolution): last, smallest, biggest. */
    roundTrip: { last: number; min: number; max: number };
    aheadFrames: number;
    delayFrames: number;
    blockFrames: number;
}

export interface BridgeProcessorOptions {
    instance: number;
    /** `instrument`: renders ahead of time, notes land on their frame. `effect`: captures input, plays it back
     * `delayFrames` later. `capture`: an effect in an export, which only captures. */
    mode: 'instrument' | 'effect' | 'capture';
    blockFrames: number;
    aheadFrames: number;
    delayFrames: number;
    /** Request buffers made up front (each `processBufferSize(blockFrames)` bytes). */
    buffers: number;
}

export const BRIDGE_PROCESSOR = 'juicyloops-bridge';

/** Defaults for live playing: 256-frame blocks, an instrument 2048 frames ahead (43 ms at 48 kHz, inside the
 * sequencer's 200 ms look-ahead), an effect's output 1280 frames (27 ms) behind its input. */
export const LIVE_BLOCK_FRAMES = 256;
export const LIVE_AHEAD_FRAMES = 2048;
export const LIVE_EFFECT_DELAY_FRAMES = 1280;
