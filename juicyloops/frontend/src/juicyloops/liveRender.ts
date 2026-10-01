import type { BaseContext, ToneAudioNode } from 'tone';
import recorderProcessorUrl from './dsp/recorderProcessor.ts?worker&url';
import { RECORDER_PROCESSOR, type RecorderCommand, type RecorderEvent } from './dsp/recorderProtocol';
import { isLegacySnapshot, type EffectsSnapshot, type LegacyEffectsSnapshot } from './effects/effects';
import { isLiveOnlyPlugin } from './plugins/catalog';
import { RenderedAudio, RenderError, type RenderScope } from './render';
import type { SessionState } from './sequencer';
import type { SynthTrackState } from './tracks/SynthTrack';

/**
 * Rendering in real time: the live engine plays the arrangement once and a recorder worklet keeps what comes out of
 * the master, so the file sounds exactly like playback. Slower than `render.ts` (it takes as long as the audio), but
 * some plugins only sound live: they take their notes or build their sound on the main thread, which an offline
 * render outruns (`PluginEntry.liveOnly`).
 *
 * This module has the audio side and the pure planning; driving the transport and putting the playback settings
 * back is `useExport`'s job, because those settings live in the UI state.
 */

/* ---- which plugins need it ---- */

const pluginsInRack = (rack: EffectsSnapshot | LegacyEffectsSnapshot): { url: string; name: string }[] =>
    isLegacySnapshot(rack) ? [] : rack.slots.flatMap((slot) => (slot.effect === 'plugin' && slot.plugin ? [slot.plugin] : []));

/**
 * The names of the plugins in a session that are silent in an offline render, each once: plugin synths and plugin
 * effect slots on tracks, container channels, returns and the master. Pass a planned state (`planRender`) to ask
 * only about what a scope plays.
 */
export const liveOnlyPlugins = (state: SessionState): string[] => {
    const plugins = [
        ...state.containers.flatMap((container) => [
            ...container.tracks.flatMap((track) => {
                const synth = track as SynthTrackState;
                return [...(synth.model === 'plugin' && synth.plugin ? [synth.plugin] : []), ...pluginsInRack(track.effects)];
            }),
            ...pluginsInRack(container.bus.effects),
        ]),
        ...(state.returns ?? []).flatMap((bus) => pluginsInRack(bus.effects)),
        ...pluginsInRack(state.master.effects),
    ];
    return [...new Set(plugins.filter((plugin) => isLiveOnlyPlugin(plugin.url)).map((plugin) => plugin.name))];
};

/* ---- mute and solo for a scope ---- */

/** One mute/solo switch to set: a track's, or (without `trackId`) a container channel's. */
export interface MixChange {
    containerId: string;
    trackId?: string;
    isSolo?: boolean;
    isMuted?: boolean;
}

/**
 * The mute and solo switches a real-time export flips so the live engine plays what an offline render of the same
 * scope would (see `planRender`), and the changes that put them back as they were.
 *
 * The song plays as it is. A container plays in loop mode, where nothing else is heard anyway, but a solo in another
 * container would silence it, so every solo outside is switched off. A single track is soloed (and unmuted: a track
 * exported on its own is meant to be heard); other solos in its container go off too, and so do those outside.
 */
export const mixChangesFor = (state: SessionState, scope: RenderScope): { apply: MixChange[]; undo: MixChange[] } => {
    const apply: MixChange[] = [];
    const undo: MixChange[] = [];
    if (scope.kind === 'song') {
        return { apply, undo };
    }
    const set = (containerId: string, trackId: string | undefined, key: 'isSolo' | 'isMuted', from: boolean, to: boolean) => {
        if (from !== to) {
            apply.push({ containerId, ...(trackId ? { trackId } : {}), [key]: to });
            undo.push({ containerId, ...(trackId ? { trackId } : {}), [key]: from });
        }
    };
    for (const container of state.containers) {
        const inside = container.id === scope.containerId;
        if (!inside) {
            set(container.id, undefined, 'isSolo', container.bus.isSolo ?? false, false);
        }
        for (const track of container.tracks) {
            if (!inside) {
                set(container.id, track.id, 'isSolo', track.isSolo ?? false, false);
            } else if (scope.kind === 'track') {
                const isTarget = track.id === scope.trackId;
                set(container.id, track.id, 'isSolo', track.isSolo ?? false, isTarget);
                if (isTarget) {
                    set(container.id, track.id, 'isMuted', track.isMuted, false);
                }
            }
        }
    }
    return { apply, undo };
};

/* ---- the recording ---- */

/** A real-time export stopped before its end (Cancel, or the stop button). */
export class RecordingCancelled extends Error {
    constructor() {
        super('The export was cancelled.');
    }
}

/** Collects the recorder's chunks into one stereo recording of a known length. */
export class LiveTake {
    readonly left: Float32Array;
    readonly right: Float32Array;
    /** Frames received so far. */
    received = 0;

    constructor(
        readonly frames: number,
        readonly sampleRate: number,
    ) {
        this.left = new Float32Array(frames);
        this.right = new Float32Array(frames);
    }

    /** Places a chunk where it belongs; anything past the end is dropped. */
    add(offset: number, left: Float32Array, right: Float32Array): void {
        const count = Math.max(0, Math.min(left.length, this.frames - offset));
        this.left.set(left.subarray(0, count), offset);
        this.right.set(right.subarray(0, count), offset);
        this.received += count;
    }

    get isComplete(): boolean {
        return this.received >= this.frames;
    }

    toAudio(): RenderedAudio {
        return new RenderedAudio([this.left, this.right], this.sampleRate);
    }
}

const registered = new WeakMap<BaseContext, Promise<void>>();

/** Loads the processor into a context once. */
const register = (context: BaseContext): Promise<void> => {
    let promise = registered.get(context);
    if (!promise) {
        promise = context.addAudioWorkletModule(recorderProcessorUrl);
        promise.catch(() => registered.delete(context));
        registered.set(context, promise);
    }
    return promise;
};

/** Whether a context can run the recorder: AudioWorklet needs a secure origin. */
export const isLiveRenderSupported = (context: BaseContext): boolean => (context.rawContext as { audioWorklet?: unknown }).audioWorklet !== undefined;

export interface LiveRecordOptions {
    /** The context time of the first frame to keep. */
    startTime: number;
    /** Seconds to keep. */
    seconds: number;
    /** Called with the seconds recorded so far, whenever a chunk arrives. */
    onProgress?: (seconds: number) => void;
}

/**
 * A recorder worklet on the live context, tapping one node (the master's output). Built with Tone's context, so it
 * is a standardized-audio-context node that Tone nodes connect to; it is fed only by such nodes, so the library does
 * not keep it natively disconnected. It has no outputs: the browser keeps processing it anyway, and nothing extra
 * reaches the speakers.
 */
export class LiveRecorder {
    private readonly node: AudioWorkletNode;
    private pending: { reject: (error: unknown) => void } | null = null;

    private constructor(
        private readonly context: BaseContext,
        private readonly source: ToneAudioNode,
    ) {
        this.node = context.createAudioWorkletNode(RECORDER_PROCESSOR, {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            // Two sides, a mono source up-mixed to both.
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
        });
        source.connect(this.node);
    }

    static async create(context: BaseContext, source: ToneAudioNode): Promise<LiveRecorder> {
        await register(context);
        return new LiveRecorder(context, source);
    }

    /**
     * Keeps `seconds` of the source from `startTime` on, to the frame. Arm it before the transport starts, with
     * `startTime` far enough ahead for the command to reach the audio thread; one that arrives late rejects.
     */
    record({ startTime, seconds, onProgress }: LiveRecordOptions): Promise<RenderedAudio> {
        const sampleRate = this.context.sampleRate;
        const take = new LiveTake(Math.round(seconds * sampleRate), sampleRate);
        return new Promise<RenderedAudio>((resolve, reject) => {
            this.pending = { reject };
            this.node.port.onmessage = (event: MessageEvent<RecorderEvent>) => {
                const message = event.data;
                if (message.type === 'chunk') {
                    take.add(message.offset, message.left, message.right);
                    onProgress?.(take.received / sampleRate);
                } else if (message.type === 'done') {
                    this.pending = null;
                    resolve(take.toAudio());
                } else {
                    this.pending = null;
                    reject(new RenderError('The recording started late. Close other busy tabs and try again.'));
                }
            };
            this.send({ type: 'record', frame: Math.round(startTime * sampleRate), frames: take.frames });
        });
    }

    /** Stops a recording in progress; its promise rejects with `error` (`RecordingCancelled` by default). */
    cancel(error: unknown = new RecordingCancelled()): void {
        this.send({ type: 'cancel' });
        this.pending?.reject(error);
        this.pending = null;
    }

    dispose(): void {
        this.cancel();
        this.send({ type: 'dispose' });
        this.node.port.onmessage = null;
        this.source.disconnect(this.node);
    }

    private send(command: RecorderCommand): void {
        this.node.port.postMessage(command);
    }
}
