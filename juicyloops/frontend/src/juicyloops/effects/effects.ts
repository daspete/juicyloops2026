import {
    AutoFilter,
    BitCrusher,
    Chorus,
    Compressor,
    connectSeries,
    Distortion,
    EQ3,
    FeedbackDelay,
    Limiter,
    Phaser,
    Reverb,
    Tremolo,
    Vibrato,
    type ToneAudioNode,
} from 'tone';
import { atTime, type AutomationParam } from '../automation';
import { EFFECT_DEFINITIONS, EFFECT_KEYS, initialParams, type EffectKey, type EffectParamDefinition, type EffectParamKey } from './definitions';

export type { EffectKey, EffectParamKey } from './definitions';

/** Anything with a numeric `value`, i.e. a Tone `Param` or `Signal`. */
interface ValueHolder {
    value: number;
    rampTo?: (value: number, rampTime: number, startTime?: number) => unknown;
}

const isValueHolder = (target: unknown): target is ValueHolder => typeof target === 'object' && target !== null && 'value' in target;

/** How quickly an automated value glides to the next one, so stepping through a lane does not click. */
const AUTOMATION_RAMP = 0.02;

/**
 * How to build each effect. Parameters are applied right after construction, so the factories only
 * need to produce a node; LFO driven effects are started here because they are silent otherwise.
 */
const FACTORIES: Record<EffectKey, () => ToneAudioNode> = {
    chorus: () => new Chorus().start(),
    phaser: () => new Phaser(),
    distortion: () => new Distortion(),
    bitCrusher: () => new BitCrusher(),
    autoFilter: () => new AutoFilter().start(),
    tremolo: () => new Tremolo().start(),
    vibrato: () => new Vibrato(),
    delay: () => new FeedbackDelay(),
    reverb: () => new Reverb(),
    compressor: () => new Compressor(),
    equalizer: () => new EQ3(),
    limiter: () => new Limiter(),
};

/** Signal flow order a fresh rack starts with. */
export const DEFAULT_EFFECT_ORDER: readonly EffectKey[] = [
    'chorus',
    'phaser',
    'distortion',
    'bitCrusher',
    'autoFilter',
    'tremolo',
    'vibrato',
    'delay',
    'reverb',
    'compressor',
    'equalizer',
    'limiter',
];

const PARAM_PREFIX = 'fx.';

/** The automation address of an effect parameter: `fx.<effect>.<param>`. */
export const effectParamKey = (effect: EffectKey, param: string): string => `${PARAM_PREFIX}${effect}.${param}`;

const parseParamKey = (key: string): { effect: EffectKey; param: string } | null => {
    if (!key.startsWith(PARAM_PREFIX)) {
        return null;
    }
    const [effect, param] = key.slice(PARAM_PREFIX.length).split('.');
    return effect && param && EFFECT_KEYS.includes(effect as EffectKey) ? { effect: effect as EffectKey, param } : null;
};

/** Every effect parameter that may be automated, in rack order, as automation sees it. Same for every rack. */
export const EFFECT_PARAMS: readonly AutomationParam[] = DEFAULT_EFFECT_ORDER.flatMap((effect) =>
    (EFFECT_DEFINITIONS[effect].params as readonly EffectParamDefinition[])
        .filter((param) => param.automatable !== false)
        .map((param) => ({
            key: effectParamKey(effect, param.key),
            label: param.label,
            group: EFFECT_DEFINITIONS[effect].label,
            min: param.min,
            max: param.max,
            step: param.step,
            curve: param.curve,
            format: param.format,
        })),
);

/**
 * An effect chain. Every track has one, so does every container bus and the master bus.
 *
 * Parameter values live here as plain numbers; the Tone nodes are only created while an effect is
 * audible (`wet > 0`) and are thrown away again when it is turned fully dry. A convolution reverb,
 * a bit crusher worklet and a handful of LFOs per track are expensive even when they have nothing
 * to do, so a fresh rack costs almost nothing and a dozen tracks stay in budget.
 *
 * The dynamics stages (compressor, equalizer, limiter) have no mix control and are cheap native
 * nodes, so they are always part of the chain and the signal sounds the same as before.
 *
 * Parameters are addressed by the keys declared in `EFFECT_DEFINITIONS`, so the UI can stay generic.
 * The order of the chain can be changed at any time; the nodes are re-wired on the spot.
 */
export class Effects {
    private readonly nodes = new Map<EffectKey, ToneAudioNode>();

    /** The current value of every parameter, whether or not the effect's node exists. */
    private readonly params = Object.fromEntries(EFFECT_KEYS.map((effect) => [effect, initialParams(effect)])) as Record<EffectKey, Record<string, number>>;

    /** Current signal flow order, first entry is closest to the sound source. */
    private chain: EffectKey[] = [...DEFAULT_EFFECT_ORDER];

    private source: ToneAudioNode | null = null;
    private destination: ToneAudioNode | null = null;

    constructor() {
        // Only the always-on dynamics stages exist from the start.
        for (const effect of EFFECT_KEYS) {
            if (this.isNeeded(effect)) {
                this.createNode(effect);
            }
        }
    }

    get order(): readonly EffectKey[] {
        return this.chain;
    }

    /** Whether the effect currently has a node in the chain. */
    isActive(effect: EffectKey): boolean {
        return this.nodes.has(effect);
    }

    /** Routes `source -> effects -> destination`. Existing connections of both ends are dropped first. */
    connect(source: ToneAudioNode, destination: ToneAudioNode): void {
        destination.disconnect();
        this.source = source;
        this.destination = destination;
        this.rewire();
    }

    /** Replaces the chain order. Keys that are missing keep their relative position at the end. */
    setOrder(order: readonly EffectKey[]): void {
        const unique = order.filter((key, index) => EFFECT_KEYS.includes(key) && order.indexOf(key) === index);
        this.chain = [...unique, ...this.chain.filter((key) => !unique.includes(key))];
        this.rewire();
    }

    /** Moves one effect one position towards the source (`-1`) or towards the output (`1`). */
    move(effect: EffectKey, direction: 1 | -1): void {
        const from = this.chain.indexOf(effect);
        const to = from + direction;
        if (from === -1 || to < 0 || to >= this.chain.length) {
            return;
        }

        const next = [...this.chain];
        [next[from], next[to]] = [next[to]!, next[from]!];
        this.setOrder(next);
    }

    /** Puts every parameter of one effect back to its initial value. */
    reset(effect: EffectKey): void {
        this.setParams(effect, initialParams(effect) as Partial<Record<EffectParamKey<typeof effect>, number>>);
    }

    getParam<K extends EffectKey>(effect: K, param: EffectParamKey<K>): number {
        return this.params[effect][param]!;
    }

    setParam<K extends EffectKey>(effect: K, param: EffectParamKey<K>, value: number): void {
        this.apply(effect, param, value);
    }

    /** Convenience for setting several parameters of one effect at once. */
    setParams<K extends EffectKey>(effect: K, params: Partial<Record<EffectParamKey<K>, number>>): void {
        for (const [key, value] of Object.entries(params) as [EffectParamKey<K>, number | undefined][]) {
            if (value !== undefined) {
                this.setParam(effect, key, value);
            }
        }
    }

    /* ---- automation ---- */

    /** Reads a parameter by its automation address (`fx.<effect>.<param>`). */
    getParameter(key: string): number {
        const address = parseParamKey(key);
        return address ? (this.params[address.effect][address.param] ?? 0) : 0;
    }

    /** Sets a parameter by its automation address, at `time` when given. */
    setParameter(key: string, value: number, time?: number): void {
        const address = parseParamKey(key);
        if (address) {
            this.apply(address.effect, address.param, value, time);
        }
    }

    /** Copies the chain order and every parameter from another effect rack. */
    copyFrom(other: Effects): void {
        this.setOrder(other.order);
        for (const effect of EFFECT_KEYS) {
            for (const param of EFFECT_DEFINITIONS[effect].params) {
                this.setParam(effect, param.key as EffectParamKey<typeof effect>, other.getParam(effect, param.key as EffectParamKey<typeof effect>));
            }
        }
    }

    dispose(): void {
        for (const node of this.nodes.values()) {
            node.dispose();
        }
        this.nodes.clear();
    }

    /**
     * Stores a value and pushes it to the node. A node is created when the effect becomes audible.
     * It is only thrown away when the user turns the effect dry: automation sweeping through zero
     * every bar must not rebuild a reverb every bar.
     */
    private apply(effect: EffectKey, param: string, value: number, time?: number): void {
        this.params[effect][param] = value;

        const shouldExist = this.isNeeded(effect);
        const node = this.nodes.get(effect);

        if (shouldExist && !node) {
            this.createNode(effect);
        } else if (!shouldExist && node && time === undefined) {
            this.destroyNode(effect);
        } else if (node) {
            this.applyParam(node, effect, param, value, true, time);
        }
    }

    /** An effect with a mix control is needed once it is not fully dry; the others are always in the chain. */
    private isNeeded(effect: EffectKey): boolean {
        const wet = this.params[effect].wet;
        return wet === undefined || wet > 0;
    }

    private createNode(effect: EffectKey): void {
        const node = FACTORIES[effect]();
        for (const [param, value] of Object.entries(this.params[effect])) {
            this.applyParam(node, effect, param, value, false);
        }
        this.nodes.set(effect, node);
        this.rewire();
    }

    private destroyNode(effect: EffectKey): void {
        const node = this.nodes.get(effect);
        if (!node) {
            return;
        }

        this.nodes.delete(effect);
        this.rewire();
        node.dispose();
    }

    private applyParam(node: ToneAudioNode, effect: EffectKey, param: string, value: number, ramp = true, time?: number): void {
        const definition = (EFFECT_DEFINITIONS[effect].params as readonly EffectParamDefinition[]).find((p) => p.key === param);
        const target = (node as unknown as Record<string, unknown>)[param];

        if (isValueHolder(target)) {
            if (time !== undefined && target.rampTo) {
                target.rampTo(value, definition?.ramp ?? AUTOMATION_RAMP, time);
            } else if (ramp && definition?.ramp && target.rampTo) {
                target.rampTo(value, definition.ramp);
            } else {
                target.value = value;
            }
            return;
        }

        atTime(time, () => {
            (node as unknown as Record<string, number>)[param] = value;
        });
    }

    /** Drops the outgoing connections of the source and every node and wires them up again in chain order. */
    private rewire(): void {
        if (!this.source || !this.destination) {
            return;
        }

        this.source.disconnect();
        for (const node of this.nodes.values()) {
            node.disconnect();
        }

        const active = this.chain.filter((key) => this.nodes.has(key)).map((key) => this.nodes.get(key)!);
        connectSeries(this.source, ...active, this.destination);
    }
}
