import type { WamNode, WebAudioModule } from '@webaudiomodules/api';
import type { BaseContext } from 'tone';
import { nativeContextOf, type LoadedPlugin } from '../plugins/wamHost';
import { bridge, BridgeError, type BridgeClient, type BridgeClientEvent } from './client';
import { offlineEffect, offlineInstrument, OFFLINE_EFFECT_BLOCK } from './offline';
import {
    BRIDGE_PROCESSOR,
    LIVE_AHEAD_FRAMES,
    LIVE_BLOCK_FRAMES,
    LIVE_EFFECT_DELAY_FRAMES,
    isBridgeState,
    pluginIdOf,
    type BridgePluginInfo,
    type BridgePluginState,
    type BridgeProcessorOptions,
    type BridgeWorkletMessage,
    type BridgeWorkletStats,
    type CreateResult,
} from './protocol';
import bridgeProcessorUrl from './bridgeProcessor.ts?worker&url';

/**
 * A desktop plugin (on the Juicy Loops Bridge) dressed as a Web Audio Module, so everything built for WAMs takes it
 * as it is: `createPlugin` in `wamHost.ts` hands `vstbridge:` addresses here, and synth tracks, effect slots, saving,
 * undo and copy/paste work unchanged.
 *
 * The node is a real native AudioNode (it connects like a WAM's): live, the bridge worklet (`bridgeProcessor.ts`);
 * in an export, the nodes of `offline.ts`. On top it has what the WAM code calls: `scheduleEvents` (wam-midi),
 * `getState`/`setState` (`{ format: 'vstbridge', chunk }`, the plugin's own state as base64) and `destroy`. Its
 * `createGui` opens the plugin's own window on the desktop and returns a small panel that says so.
 *
 * If the bridge restarts while the studio is open, the plugin comes back by itself with the state last read.
 */

interface WamMidiEvent {
    type: string;
    time?: number;
    data?: { bytes?: number[] };
}

/** What a bridge plugin's node offers beyond being an AudioNode. */
export interface BridgeNodeExtras {
    readonly bridgeInstance: () => number;
    /** Seconds the plugin is behind its input (effects; live blocks or export blocks), plus its own latency. */
    readonly bridgeLatency: () => number;
    readonly bridgeInfo: BridgePluginInfo;
    scheduleEvents(...events: WamMidiEvent[]): void;
    getState(): Promise<BridgePluginState | null>;
    setState(state: unknown): Promise<void>;
    destroy(): void;
    /** Counters of the live worklet (round trip, gaps), for tests and the curious. */
    stats(): Promise<BridgeWorkletStats | null>;
}

const registered = new WeakMap<BaseAudioContext, Promise<void>>();

const registerProcessor = (context: BaseAudioContext): Promise<void> => {
    let promise = registered.get(context);
    if (!promise) {
        promise = context.audioWorklet.addModule(bridgeProcessorUrl);
        promise.catch(() => registered.delete(context));
        registered.set(context, promise);
    }
    return promise;
};

const isOfflineContext = (context: BaseAudioContext): context is OfflineAudioContext =>
    typeof OfflineAudioContext !== 'undefined' && context instanceof OfflineAudioContext;

const midiBytes = (event: WamMidiEvent): [number, number, number] | null => {
    const bytes = event.data?.bytes;
    if (event.type !== 'wam-midi' || !bytes || bytes.length < 1) {
        return null;
    }
    return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0];
};

/** The plugin as the bridge lists it (the list is fetched again when it is not there yet). */
const findPlugin = async (client: BridgeClient, pluginId: string): Promise<BridgePluginInfo> => {
    const listed = client.plugins.value.find((plugin) => plugin.id === pluginId) ?? (await client.refreshPlugins()).find((plugin) => plugin.id === pluginId);
    if (!listed) {
        throw new BridgeError('not-found', 'This desktop plugin is not installed on this computer (or the bridge has not found it yet).');
    }
    return listed;
};

/** The panel the studio's plugin window shows: the real window is on the desktop. */
const makePanel = (
    info: BridgePluginInfo,
    hasEditor: boolean,
    open: () => Promise<void>,
): { element: HTMLElement; closedOnDesktop(): void; failed(message: string): void } => {
    const element = document.createElement('div');
    element.className = 'bridge-gui';
    const title = document.createElement('p');
    title.className = 'bridge-gui-title';
    const name = document.createElement('strong');
    name.textContent = info.name;
    title.append(name, document.createTextNode(hasEditor ? '’s window is open on your desktop.' : ' has no window of its own.'));
    const text = document.createElement('p');
    text.className = 'bridge-gui-text';
    text.textContent = hasEditor
        ? 'It runs in the Juicy Loops Bridge. Whatever you change there is kept with this project.'
        : 'It runs in the Juicy Loops Bridge and plays with its current settings.';
    const error = document.createElement('p');
    error.className = 'bridge-gui-error';
    error.hidden = true;
    element.append(title, text);
    if (hasEditor) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bridge-gui-button';
        button.textContent = 'Show the window again';
        button.addEventListener('click', () => {
            error.hidden = true;
            title.lastChild!.textContent = '’s window is open on your desktop.';
            open().catch((reason: unknown) => {
                error.hidden = false;
                error.textContent = reason instanceof Error ? reason.message : 'The window could not open.';
            });
        });
        element.append(button);
    }
    element.append(error);
    return {
        element,
        closedOnDesktop: () => {
            title.lastChild!.textContent = '’s window was closed on the desktop.';
        },
        failed: (message) => {
            error.hidden = false;
            error.textContent = message;
        },
    };
};

/** Creates a bridge plugin on a Tone context (live or offline), with a stored state when there is one. */
export const createBridgePlugin = async (context: BaseContext, url: string, state: unknown, client: BridgeClient = bridge): Promise<LoadedPlugin> => {
    const pluginId = pluginIdOf(url);
    await client.connect();
    const info = await findPlugin(client, pluginId);
    const native = nativeContextOf(context);
    const offline = isOfflineContext(native);
    const isInstrument = info.kind === 'instrument';
    let lastState: BridgePluginState | null = isBridgeState(state) ? state : null;
    // One worklet module per context, while the instance starts on the bridge.
    const registering = registerProcessor(native);

    const createInstance = (): Promise<CreateResult> =>
        client.create({
            pluginId,
            sampleRate: native.sampleRate,
            maxBlock: offline ? Math.max(OFFLINE_EFFECT_BLOCK, 4096) : LIVE_BLOCK_FRAMES,
            inputChannels: isInstrument ? 0 : 2,
            state: lastState?.chunk ?? null,
            mode: offline ? 'offline' : 'live',
        });
    let created = await createInstance();

    let node: AudioNode;
    let destroyed = false;
    let link: (() => Promise<void>) | null = null;
    let worklet: AudioWorkletNode | null = null;
    let schedule: (time: number, bytes: [number, number, number]) => void;
    let latencyFrames: number;
    let disposeOffline: () => void = () => undefined;
    let panel: ReturnType<typeof makePanel> | null = null;

    try {
        await registering;
        if (!offline) {
            const options: BridgeProcessorOptions = {
                instance: created.instance,
                mode: isInstrument ? 'instrument' : 'effect',
                blockFrames: LIVE_BLOCK_FRAMES,
                aheadFrames: LIVE_AHEAD_FRAMES,
                delayFrames: LIVE_EFFECT_DELAY_FRAMES,
                buffers: 48,
            };
            const live = new AudioWorkletNode(native, BRIDGE_PROCESSOR, {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                channelCount: 2,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers',
                processorOptions: options,
            });
            worklet = live;
            const post = (message: BridgeWorkletMessage, transfer: Transferable[] = []) => live.port.postMessage(message, transfer);
            link = async () => {
                const channel = new MessageChannel();
                post({ type: 'link', port: channel.port1 }, [channel.port1]);
                await client.attachAudio(created.instance, channel.port2);
            };
            await link();
            schedule = (time, bytes) => post({ type: 'midi', time, bytes });
            latencyFrames = isInstrument ? 0 : LIVE_EFFECT_DELAY_FRAMES;
            node = live;
        } else {
            const toWorker = new MessageChannel();
            await client.attachAudio(created.instance, toWorker.port2);
            if (isInstrument) {
                const instrument = offlineInstrument(native, created.instance, toWorker.port1);
                schedule = instrument.schedule;
                disposeOffline = instrument.dispose;
                latencyFrames = 0;
                node = instrument.output;
            } else {
                const capture = new AudioWorkletNode(native, BRIDGE_PROCESSOR, {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                    channelCount: 2,
                    channelCountMode: 'explicit',
                    processorOptions: {
                        instance: created.instance,
                        mode: 'capture',
                        blockFrames: OFFLINE_EFFECT_BLOCK,
                        aheadFrames: 0,
                        delayFrames: OFFLINE_EFFECT_BLOCK,
                        buffers: 16,
                    } satisfies BridgeProcessorOptions,
                });
                const toProcessor = new MessageChannel();
                capture.port.postMessage({ type: 'link', port: toProcessor.port1 } satisfies BridgeWorkletMessage, [toProcessor.port1]);
                const effect = offlineEffect(native, capture, toProcessor.port2, toWorker.port1);
                disposeOffline = effect.dispose;
                schedule = () => undefined;
                latencyFrames = OFFLINE_EFFECT_BLOCK;
                // The input goes into the capture worklet; what WAM code connects onwards comes from the output.
                const output = effect.output;
                const input = capture as AudioNode & { connect: AudioNode['connect']; disconnect: AudioNode['disconnect'] };
                input.connect = ((...args: Parameters<AudioNode['connect']>) =>
                    (output.connect as (...rest: unknown[]) => unknown)(...args)) as AudioNode['connect'];
                input.disconnect = ((...args: unknown[]) => (output.disconnect as (...rest: unknown[]) => unknown)(...args)) as AudioNode['disconnect'];
                node = input;
            }
        }
    } catch (error) {
        // Nothing half-made stays behind on the bridge.
        worklet?.port.postMessage({ type: 'stop' } satisfies BridgeWorkletMessage);
        client.detachAudio(created.instance);
        void client.destroy(created.instance).catch(() => undefined);
        throw error;
    }
    client.retain();
    // Tempo for tempo-synced plugins: an export's is fixed, live it follows the transport.
    const transport = context.transport;
    if (offline) {
        await client.request('transport', { instance: created.instance, bpm: transport.bpm.value, playing: true }).catch(() => undefined);
    } else {
        client.watchTransport(() => ({ bpm: transport.bpm.value, playing: transport.state === 'started' }));
    }

    // The bridge restarted: start the plugin again where it was (live only; an export simply fails).
    const unsubscribe = client.onEvent((event: BridgeClientEvent) => {
        if (destroyed) {
            return;
        }
        if (event.event === 'connected' && link) {
            void createInstance()
                .then(async (again) => {
                    if (destroyed) {
                        void client.destroy(again.instance).catch(() => undefined);
                        return;
                    }
                    created = again;
                    worklet?.port.postMessage({ type: 'instance', instance: again.instance } satisfies BridgeWorkletMessage);
                    await link!();
                })
                .catch((error: unknown) => console.warn('The desktop plugin could not start again.', error));
        } else if (event.event === 'editorClosed' && event.instance === created.instance) {
            panel?.closedOnDesktop();
        } else if (event.event === 'latencyChanged' && event.instance === created.instance) {
            created = { ...created, latency: event.latency };
        }
    });

    const openEditor = () => client.openEditor(created.instance, info.name);

    const extras: BridgeNodeExtras = {
        bridgeInstance: () => created.instance,
        bridgeLatency: () => (latencyFrames + created.latency) / native.sampleRate,
        bridgeInfo: info,
        scheduleEvents: (...events: WamMidiEvent[]) => {
            for (const event of events) {
                const bytes = midiBytes(event);
                if (bytes) {
                    schedule(event.time ?? native.currentTime, bytes);
                }
            }
        },
        getState: async () => {
            try {
                lastState = { format: 'vstbridge', chunk: await client.getState(created.instance) };
                return lastState;
            } catch {
                // Keep what the session has (a null state is ignored by the callers).
                return null;
            }
        },
        setState: async (next: unknown) => {
            if (isBridgeState(next)) {
                lastState = next;
                await client.setState(created.instance, next.chunk);
            }
        },
        destroy: () => {
            if (destroyed) {
                return;
            }
            destroyed = true;
            unsubscribe();
            disposeOffline();
            worklet?.port.postMessage({ type: 'stop' } satisfies BridgeWorkletMessage);
            client.detachAudio(created.instance);
            void client.destroy(created.instance).catch(() => undefined);
            client.release();
        },
        stats: () =>
            new Promise((resolve) => {
                if (!worklet) {
                    resolve(null);
                    return;
                }
                const live = worklet;
                const timer = setTimeout(() => resolve(null), 1000);
                const previous = live.port.onmessage;
                live.port.onmessage = (event: MessageEvent<BridgeWorkletStats>) => {
                    if (event.data?.type === 'stats') {
                        clearTimeout(timer);
                        live.port.onmessage = previous;
                        resolve(event.data);
                    }
                };
                live.port.postMessage({ type: 'stats' } satisfies BridgeWorkletMessage);
            }),
    };
    const pluginNode = Object.assign(node, extras);

    const module = {
        descriptor: { name: info.name, vendor: info.vendor, isInstrument, identifier: pluginId, version: info.version },
        audioNode: pluginNode,
        createGui: async (): Promise<HTMLElement> => {
            panel = makePanel(info, created.hasEditor, openEditor);
            if (created.hasEditor) {
                await openEditor().catch((error: unknown) => panel?.failed(error instanceof Error ? error.message : 'The window could not open.'));
            }
            return panel.element;
        },
        destroyGui: (element: Element) => {
            element.remove();
            panel = null;
            void client.closeEditor(created.instance).catch(() => undefined);
        },
    };

    return {
        module: module as unknown as WebAudioModule<WamNode>,
        node: pluginNode as unknown as WamNode,
        name: info.name,
        vendor: info.vendor,
        isInstrument,
    };
};
