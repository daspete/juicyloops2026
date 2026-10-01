import type { WamNode, WebAudioModule } from '@webaudiomodules/api';
import { Gain, ToneAudioNode, type BaseContext } from 'tone';
import type { PluginRef } from './pluginRef';
import { pluginErrorMessage, setPluginStatus } from './pluginStatus';

export interface WamEffectOptions {
    context: BaseContext;
    /** Whose plugin it is, for its status (`pluginStatus`). */
    owner: string;
    plugin: PluginRef;
}

/**
 * A WAM effect as a node of an effect rack: `input -> plugin -> output`. While the plugin loads, or when it cannot,
 * the sound passes straight through, so a slow or broken plugin never silences a track. `ready` (what an offline
 * render waits for) resolves once it is in the path, or failed.
 */
export class WamEffect extends ToneAudioNode {
    readonly name: string = 'WamEffect';
    readonly input: Gain;
    readonly output: Gain;
    readonly ready: Promise<void>;

    private plugin: { module: WebAudioModule<WamNode>; node: WamNode } | null = null;
    private keepAlive: { stop(): void } | null = null;
    /** A muted path from input to output that stays when the plugin is in (see `load`). */
    private reach: Gain | null = null;
    private readonly owner: string;
    private isDisposed = false;

    constructor({ context, owner, plugin }: WamEffectOptions) {
        super({ context });
        this.input = new Gain({ context: this.context });
        this.output = new Gain({ context: this.context });
        this.input.connect(this.output);
        this.owner = owner;
        this.ready = this.load(plugin);
    }

    /** The loaded plugin (its GUI), or null while it loads or when it failed. */
    get module(): WebAudioModule<WamNode> | null {
        return this.plugin?.module ?? null;
    }

    async getState(): Promise<unknown> {
        if (!this.plugin) {
            return null;
        }
        const { pluginState } = await import('./wamHost');
        return pluginState(this.plugin.node);
    }

    dispose(): this {
        super.dispose();
        this.isDisposed = true;
        this.keepAlive?.stop();
        this.keepAlive = null;
        const plugin = this.plugin;
        this.plugin = null;
        if (plugin) {
            try {
                plugin.node.disconnect();
                plugin.node.destroy();
            } catch {
                /* already gone */
            }
        }
        this.reach?.dispose();
        this.input.dispose();
        this.output.dispose();
        return this;
    }

    private status(status: Parameters<typeof setPluginStatus>[1]): void {
        if (!this.context.isOffline) {
            setPluginStatus(this.owner, status);
        }
    }

    private async load(ref: PluginRef): Promise<void> {
        this.status({ state: 'loading' });
        try {
            const { createPlugin, keepActive, nativeNodeOf } = await import('./wamHost');
            const loaded = await createPlugin(this.context, ref.url, ref.state);
            if (this.isDisposed) {
                loaded.node.destroy();
                return;
            }
            // The output would count as passive once the direct path is gone (see `keepActive`).
            this.keepAlive = keepActive(this.context, this.output.input);
            nativeNodeOf(this.input).connect(loaded.node);
            loaded.node.connect(nativeNodeOf(this.output));
            // In an offline context standardized-audio-context connects the native nodes only when rendering starts,
            // and only those it reaches from the destination. Without any path of its own from the input onwards, the
            // input is never reached, nothing upstream is connected to it, and the plugin hears silence in exports.
            // A muted path keeps it reachable.
            this.reach = new Gain({ context: this.context, gain: 0 });
            this.input.connect(this.reach);
            this.reach.connect(this.output);
            this.input.disconnect(this.output);
            this.plugin = { module: loaded.module, node: loaded.node };
            this.status({ state: 'ready', name: loaded.name, vendor: loaded.vendor });
        } catch (error) {
            console.warn('The plugin could not load; the sound passes by it.', error);
            if (!this.isDisposed) {
                this.status({ state: 'error', message: pluginErrorMessage(error) });
            }
        }
    }
}
