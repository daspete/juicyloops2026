import type { WamNode, WebAudioModule } from '@webaudiomodules/api';
import { ToneAudioNode, type BaseContext } from 'tone';
import { noteFrequency } from '../dsp/SynthVoices';
import type { SynthEngine } from '../tracks/synthEngine';
import type { PluginRef } from './pluginRef';
import { pluginErrorMessage, setPluginStatus } from './pluginStatus';

/** MIDI key of a note name or frequency. */
const midiKey = (note: string | number): number => Math.min(127, Math.max(0, Math.round(69 + 12 * Math.log2(noteFrequency(note) / 440))));

const velocityByte = (velocity: number): number => Math.min(127, Math.max(1, Math.round(velocity * 127)));

type MidiBytes = [number, number, number];

export interface WamInstrumentOptions {
    context: BaseContext;
    /** Whose plugin it is, for its status (`pluginStatus`). */
    owner: string;
    plugin: PluginRef;
    /** Semitones a full pitch bend reaches; the plugin gets bends as MIDI pitch bend of that range. */
    bendRange: number;
}

/**
 * A WAM instrument as a synth track's engine. Notes go to the plugin as MIDI events stamped with their context time
 * (sample accurate in the plugin); pitch bend as MIDI pitch bend. The plugin loads in the background: until it is
 * there, events wait and go out in order, and `whenReady` (what an offline render waits for) resolves once it is,
 * or failed.
 */
export class WamInstrument extends ToneAudioNode implements SynthEngine {
    readonly name: string = 'WamInstrument';
    readonly input = undefined;
    readonly output: GainNode;

    private plugin: { module: WebAudioModule<WamNode>; node: WamNode } | null = null;
    private keepAlive: { stop(): void } | null = null;
    private readonly waiting: { bytes: MidiBytes; time: number }[] = [];
    private readonly ready: Promise<void>;
    private readonly owner: string;
    private bendRange: number;
    /** The key each live note plays. */
    private readonly liveKeys = new Map<number, number>();
    private isDisposed = false;

    constructor({ context, owner, plugin, bendRange }: WamInstrumentOptions) {
        super({ context });
        this.output = this.context.createGain();
        this.owner = owner;
        this.bendRange = bendRange;
        this.ready = this.load(plugin);
    }

    /** The loaded plugin (its GUI, parameters), or null while it loads or when it failed. */
    get module(): WebAudioModule<WamNode> | null {
        return this.plugin?.module ?? null;
    }

    triggerAttackRelease(note: string | number, duration: string | number, time: number, velocity = 1): number {
        const seconds = this.toSeconds(duration);
        const key = midiKey(note);
        this.send([0x90, key, velocityByte(velocity)], time);
        this.send([0x80, key, 0], time + seconds);
        return seconds;
    }

    noteOn(id: number, note: string | number, time: number, velocity: number): void {
        const key = midiKey(note);
        this.liveKeys.set(id, key);
        this.send([0x90, key, velocityByte(velocity)], time);
    }

    noteOff(id: number, time: number): void {
        const key = this.liveKeys.get(id);
        if (key !== undefined) {
            this.liveKeys.delete(id);
            this.send([0x80, key, 0], time);
        }
    }

    setBend(semitones: number, time?: number): void {
        const amount = Math.min(1, Math.max(-1, semitones / this.bendRange));
        const value = Math.round(8192 + amount * (amount > 0 ? 8191 : 8192));
        this.send([0xe0, value & 0x7f, value >> 7], time ?? this.context.currentTime);
    }

    setBendRange(semitones: number): void {
        this.bendRange = semitones;
    }

    /** The plugin decides how it plays notes. */
    setCutsNotes(): void {}
    setOscillatorType(): void {}
    setEnvelope(): void {}
    setPatchParam(): void {}

    whenReady(): Promise<void> {
        return this.ready;
    }

    /** The plugin's current state, or null. */
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
        this.waiting.length = 0;
        this.keepAlive?.stop();
        this.keepAlive = null;
        this.destroyPlugin();
        return this;
    }

    private send(bytes: MidiBytes, time: number): void {
        if (this.plugin) {
            this.plugin.node.scheduleEvents({ type: 'wam-midi', time, data: { bytes } });
        } else if (!this.isDisposed) {
            this.waiting.push({ bytes, time });
        }
    }

    /** Status for the UI; an offline render's copy of the plugin keeps quiet. */
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
            this.keepAlive = keepActive(this.context, this.output);
            loaded.node.connect(nativeNodeOf(this.output));
            this.plugin = { module: loaded.module, node: loaded.node };
            for (const { bytes, time } of this.waiting.splice(0)) {
                loaded.node.scheduleEvents({ type: 'wam-midi', time, data: { bytes } });
            }
            this.status({ state: 'ready', name: loaded.name, vendor: loaded.vendor });
        } catch (error) {
            console.warn('The plugin could not load.', error);
            if (!this.isDisposed) {
                this.status({ state: 'error', message: pluginErrorMessage(error) });
            }
        }
    }

    private destroyPlugin(): void {
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
    }
}

