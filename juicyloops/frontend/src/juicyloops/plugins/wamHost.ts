import type { WamNode, WebAudioModule } from '@webaudiomodules/api';
// The host initializer alone: the SDK's index also defines `WamNode extends AudioWorkletNode`, which throws where
// there is no AudioWorkletNode (prerendering, unit tests).
import initializeWamHost from '@webaudiomodules/sdk/src/initializeWamHost.js';
import type { BaseContext } from 'tone';

/**
 * Hosting Web Audio Modules (WAM 2.0): plugins loaded from a URL, running in the page.
 *
 * Tone wraps the browser's AudioContext in standardized-audio-context, whose nodes only connect to each other; a
 * plugin makes plain browser nodes on the plain context. So plugins are created on the native context behind Tone's,
 * and audio crosses between the two worlds through the native node behind a wrapped one (`nativeNodeOf`).
 *
 * This module is loaded on demand (the first plugin), so the SDK is not part of the studio's first load.
 */

type WamClass = {
    createInstance(groupId: string, audioContext: BaseAudioContext, initialState?: unknown): Promise<WebAudioModule<WamNode>>;
    isWebAudioModuleConstructor?: boolean;
};

/** The browser's own context behind a Tone context (live or offline). */
export const nativeContextOf = (context: BaseContext): BaseAudioContext => {
    const raw = context.rawContext as unknown as { _nativeContext?: BaseAudioContext };
    return raw._nativeContext ?? (context.rawContext as unknown as BaseAudioContext);
};

/** The browser's own node behind a standardized-audio-context node (a Tone node's `input`/`output`, or a node from `context.createGain()`). */
export const nativeNodeOf = (node: unknown): AudioNode => {
    const wrapped = node as { _nativeAudioNode?: AudioNode; input?: unknown };
    if (wrapped._nativeAudioNode) {
        return wrapped._nativeAudioNode;
    }
    if (wrapped.input && wrapped.input !== node) {
        return nativeNodeOf(wrapped.input);
    }
    return node as AudioNode;
};

/**
 * standardized-audio-context keeps a node it thinks is passive (nothing of its own feeds it) natively disconnected
 * from what it connects to. A plugin feeding a wrapped node from outside does not count, so a bridge node would stay
 * silent: a silent constant source started into it keeps it active. Returns what to stop and disconnect later.
 */
export const keepActive = (context: BaseContext, node: AudioNode | { connect(destination: unknown): unknown }): { stop(): void } => {
    const source = context.createConstantSource();
    source.offset.value = 0;
    source.connect(node as never);
    source.start();
    return {
        stop: () => {
            try {
                source.stop();
                source.disconnect();
            } catch {
                /* already stopped */
            }
        },
    };
};

/** The WAM host group of each native context: registered once per context (each offline render has its own). */
const groups = new WeakMap<BaseAudioContext, Promise<string>>();

const hostGroup = (context: BaseAudioContext): Promise<string> => {
    let group = groups.get(context);
    if (!group) {
        group = initializeWamHost(context).then(([id]) => id);
        groups.set(context, group);
    }
    return group;
};

/** Plugin modules by URL: fetched and evaluated once per page. */
const modules = new Map<string, Promise<WamClass>>();

const loadModule = (url: string): Promise<WamClass> => {
    let module = modules.get(url);
    if (!module) {
        module = import(/* @vite-ignore */ url).then((loaded: { default?: WamClass }) => {
            if (!loaded.default || typeof loaded.default.createInstance !== 'function') {
                throw new Error('That address is not a Web Audio Module (it has no default export with createInstance).');
            }
            return loaded.default;
        });
        // A failed load may be a network hiccup: the next attempt tries again.
        module.catch(() => modules.delete(url));
        modules.set(url, module);
    }
    return module;
};

export interface LoadedPlugin {
    module: WebAudioModule<WamNode>;
    node: WamNode;
    name: string;
    vendor: string;
    isInstrument: boolean;
}

/** Creates a plugin instance on a Tone context, with a stored state when there is one. */
export const createPlugin = async (context: BaseContext, url: string, state?: unknown): Promise<LoadedPlugin> => {
    const native = nativeContextOf(context);
    const [Wam, group] = await Promise.all([loadModule(url), hostGroup(native)]);
    const module = await Wam.createInstance(group, native, state ?? undefined);
    const node = module.audioNode;
    if (state !== undefined && state !== null) {
        // Not every plugin applies an initial state; setting it again is harmless.
        await node.setState(state);
    }
    return { module, node, name: module.descriptor?.name ?? 'Plugin', vendor: module.descriptor?.vendor ?? '', isInstrument: !!module.descriptor?.isInstrument };
};

/** A plugin's state, or null when it cannot give one. Kept JSON-safe: sessions and history store it. */
export const pluginState = async (node: WamNode): Promise<unknown> => {
    try {
        const state = await node.getState();
        return state === undefined ? null : JSON.parse(JSON.stringify(state));
    } catch {
        return null;
    }
};
