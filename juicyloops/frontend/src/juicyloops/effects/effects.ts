import {
    AutoFilter,
    Chorus,
    Compressor,
    connectSeries,
    Distortion,
    FeedbackDelay,
    Limiter,
    Phaser,
    Reverb,
    Tremolo,
    Vibrato,
    type ToneAudioNode,
} from 'tone';
import { atTime, type AutomationParam } from '../automation';
import { Crusher } from './crusher';
import { Equalizer } from './equalizer';
import {
    EFFECT_DEFINITIONS,
    EFFECT_KEYS,
    initialParams,
    isEffectNeeded,
    type EffectKey,
    type EffectParamDefinition,
    type EffectParamKey,
    type EffectRackRole,
} from './definitions';

export type { EffectKey, EffectParamKey, EffectRackRole } from './definitions';

/** The stored state of a rack: the chain order and every parameter value. */
export interface EffectsSnapshot {
    order: EffectKey[];
    params: Record<EffectKey, Record<string, number>>;
}

/**
 * The params of a stored snapshot, brought up to date. Snapshots from before the limiter had an on/off switch
 * have no `limiter.on`; their limiter was always active, so it restores switched on and the session sounds as it
 * did. Compressor and equalizer values were always stored in full, so they need nothing. Session files, history
 * and duplicated tracks all come through here (`Effects.restore`) or copy a live rack (`Effects.copyFrom`).
 */
export const upgradeEffectParams = (params: Partial<EffectsSnapshot['params']>): Partial<EffectsSnapshot['params']> => ({
    ...params,
    limiter: { ...params.limiter, on: params.limiter?.on ?? 1 },
});

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
    bitCrusher: () => new Crusher(),
    autoFilter: () => new AutoFilter().start(),
    tremolo: () => new Tremolo().start(),
    vibrato: () => new Vibrato(),
    delay: () => new FeedbackDelay(),
    reverb: () => new Reverb(),
    compressor: () => new Compressor(),
    equalizer: () => new Equalizer(),
    limiter: () => new Limiter(),
};

/**
 * How many times a delay repeats before it has died away to -60 dB. The rack's delay keeps Tone's default feedback
 * (it has no knob for it), so the count is fixed.
 */
const DELAY_REPEATS = Math.ceil(Math.log(0.001) / Math.log(FeedbackDelay.getDefaults().feedback));

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

type ParamAddress = { readonly effect: EffectKey; readonly param: string };

/** Parsed keys, so automation (every lane, every step) does not split strings and allocate on each call. */
const PARSED_KEYS = new Map<string, ParamAddress | null>();

const parseParamKey = (key: string): ParamAddress | null => {
    let address = PARSED_KEYS.get(key);
    if (address === undefined) {
        const [effect, param] = key.startsWith(PARAM_PREFIX) ? key.slice(PARAM_PREFIX.length).split('.') : [];
        address = effect && param && EFFECT_KEYS.includes(effect as EffectKey) ? { effect: effect as EffectKey, param } : null;
        PARSED_KEYS.set(key, address);
    }
    return address;
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
 * a bit crusher and a handful of LFOs per track are expensive even when they have nothing
 * to do, so a fresh rack costs almost nothing and a dozen tracks stay in budget.
 *
 * The dynamics stages (compressor, equalizer, limiter) have no mix control. They follow the same rule
 * with their own idea of "doing nothing" (`isNeutral` in the definitions): ratio 1, a flat EQ, the
 * limiter switched off. A fresh track or bus rack starts that way and has no nodes at all; the master
 * starts with its limiter on (see `EffectRackRole`).
 *
 * Parameters are addressed by the keys declared in `EFFECT_DEFINITIONS`, so the UI can stay generic.
 * The order of the chain can be changed at any time; the nodes are re-wired on the spot.
 */
export class Effects {
    private readonly nodes = new Map<EffectKey, ToneAudioNode>();

    /** The current value of every parameter, whether or not the effect's node exists. */
    private readonly params: Record<EffectKey, Record<string, number>>;

    /** Current signal flow order, first entry is closest to the sound source. */
    private chain: EffectKey[] = [...DEFAULT_EFFECT_ORDER];

    private source: ToneAudioNode | null = null;
    private destination: ToneAudioNode | null = null;

    /** While suspended the rack has no nodes at all and the sound passes straight through; see `suspend`. */
    private isSuspended = false;

    /** Where the rack sits; decides the values it starts with and goes back to on `reset`. */
    readonly role: EffectRackRole;

    constructor({ role = 'track' }: { role?: EffectRackRole } = {}) {
        this.role = role;
        this.params = Object.fromEntries(EFFECT_KEYS.map((effect) => [effect, initialParams(effect, role)])) as Record<EffectKey, Record<string, number>>;
        // Only what the role switches on exists from the start: nothing on a track or bus, the limiter on the master.
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

    /**
     * Whether an effect with these values (by default the stored ones) changes the sound and so needs its node:
     * a mixable effect once it is not fully dry, a dynamics stage once it is not neutral. The UI lights an effect by this.
     */
    isNeeded(effect: EffectKey, params: Readonly<Record<string, number>> = this.params[effect]): boolean {
        return isEffectNeeded(effect, params);
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

    /** Puts every parameter of one effect back to its initial value (the master's limiter goes back to on). */
    reset(effect: EffectKey): void {
        this.setParams(effect, initialParams(effect, this.role) as Partial<Record<EffectParamKey<typeof effect>, number>>);
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

    /**
     * Sets a parameter by its automation address. With a `time` the value is only played, not stored:
     * automation moves the sound, the knob keeps what the user set, and `settle` brings the sound back to it.
     */
    setParameter(key: string, value: number, time?: number): void {
        const address = parseParamKey(key);
        if (!address) {
            return;
        }
        if (time === undefined) {
            this.apply(address.effect, address.param, value);
        } else {
            this.applyLive(address.effect, address.param, value, time);
        }
    }

    /** Puts the stored value of a parameter back on its node, after automation moved it. */
    settle(key: string): void {
        const address = parseParamKey(key);
        if (address) {
            this.apply(address.effect, address.param, this.params[address.effect][address.param] ?? 0);
        }
    }

    capture(): EffectsSnapshot {
        return {
            order: [...this.chain],
            params: Object.fromEntries(EFFECT_KEYS.map((effect) => [effect, { ...this.params[effect] }])) as EffectsSnapshot['params'],
        };
    }

    restore(snapshot: EffectsSnapshot): void {
        this.setOrder(snapshot.order);
        const params = upgradeEffectParams(snapshot.params);
        for (const effect of EFFECT_KEYS) {
            for (const [param, value] of Object.entries(params[effect] ?? {})) {
                if (this.params[effect][param] !== value) {
                    this.apply(effect, param, value);
                }
            }
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

    /**
     * Resolves once every effect can make a sound. A reverb renders its impulse response in the background
     * after it is created or changed; until then it is silent. Offline rendering waits for this.
     */
    async whenReady(): Promise<void> {
        await Promise.all([...this.nodes.values()].map((node) => (node as { ready?: Promise<unknown> }).ready));
    }

    /**
     * Throws every node away and keeps the values: a rack whose container sleeps (see `hibernate.ts`) costs nothing.
     * Changes made meanwhile are stored as usual, automation played meanwhile is ignored. The sound passes straight
     * through, so call it only once nothing it plays can still be heard.
     */
    suspend(): void {
        if (this.isSuspended) {
            return;
        }
        this.isSuspended = true;
        const nodes = [...this.nodes.values()];
        this.nodes.clear();
        this.rewire();
        for (const node of nodes) {
            node.dispose();
        }
    }

    /** Builds the nodes again from the stored values. A reverb renders its impulse response in the background (`whenReady`). */
    resume(): void {
        if (!this.isSuspended) {
            return;
        }
        this.isSuspended = false;
        for (const effect of this.chain) {
            if (this.isNeeded(effect)) {
                this.nodes.set(effect, this.buildNode(effect));
            }
        }
        this.rewire();
    }

    /**
     * Seconds the rack keeps sounding after its input fell silent: a reverb's decay and pre-delay, a delay's repeats.
     * Counts every effect that has a node or should have one, at the larger of its stored and its live delay time.
     */
    tail(): number {
        let seconds = 0;
        const reverb = this.nodes.get('reverb');
        if (reverb || this.isNeeded('reverb')) {
            seconds += (this.params.reverb.decay ?? 0) + (this.params.reverb.preDelay ?? 0);
        }
        const delay = this.nodes.get('delay') as FeedbackDelay | undefined;
        if (delay || this.isNeeded('delay')) {
            const time = Math.max(this.params.delay.delayTime ?? 0, delay ? delay.toSeconds(delay.delayTime.value) : 0);
            seconds += time * DELAY_REPEATS;
        }
        return seconds;
    }

    dispose(): void {
        for (const node of this.nodes.values()) {
            node.dispose();
        }
        this.nodes.clear();
    }

    /** Stores a value and pushes it to the node. The node comes and goes with the effect being audible. */
    private apply(effect: EffectKey, param: string, value: number): void {
        this.params[effect][param] = value;
        if (this.isSuspended) {
            return;
        }

        const shouldExist = this.isNeeded(effect);
        const node = this.nodes.get(effect);

        if (shouldExist && !node) {
            this.createNode(effect);
        } else if (!shouldExist && node) {
            this.destroyNode(effect);
        } else if (node) {
            this.applyParam(node, effect, param, value, true);
        }
    }

    /**
     * Plays a value at a time without storing it. A node that does not exist yet is created when the value, put
     * over the stored ones, would make the effect audible (a mix above zero, a neutral compressor's ratio above 1).
     * It is never thrown away here: automation sweeping through zero every bar must not rebuild a reverb every bar.
     */
    private applyLive(effect: EffectKey, param: string, value: number, time: number): void {
        let node = this.nodes.get(effect);
        if (!node) {
            if (this.isSuspended || !this.isNeeded(effect, { ...this.params[effect], [param]: value })) {
                return;
            }
            this.createNode(effect);
            node = this.nodes.get(effect)!;
        }
        this.applyParam(node, effect, param, value, true, time);
    }

    private createNode(effect: EffectKey): void {
        this.nodes.set(effect, this.buildNode(effect));
        this.rewire();
    }

    /** A new node for an effect with the stored values on it; not wired yet. */
    private buildNode(effect: EffectKey): ToneAudioNode {
        const node = FACTORIES[effect]();
        for (const [param, value] of Object.entries(this.params[effect])) {
            this.applyParam(node, effect, param, value, false);
        }
        return node;
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
        if (definition?.toggle) {
            // A switch only decides whether the node exists (`apply`); the node has no such property.
            return;
        }
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

        atTime(node.context, time, () => {
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
