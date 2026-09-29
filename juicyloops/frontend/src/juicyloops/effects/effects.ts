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
import { shallowRef } from 'vue';
import { atTime, createParameterTable, type AutomationParam, type ParameterTable } from '../automation';
import { Crusher } from './crusher';
import { Equalizer } from './equalizer';
import {
    addedParams,
    EFFECT_DEFINITIONS,
    EFFECT_KEYS,
    initialParams,
    isEffectNeeded,
    type EffectKey,
    type EffectParamDefinition,
    type EffectRackRole,
} from './definitions';

export type { EffectKey, EffectParamKey, EffectRackRole } from './definitions';

/** One slot of a chain as it is stored. */
export interface EffectSlotSnapshot {
    id: string;
    effect: EffectKey;
    bypassed: boolean;
    params: Record<string, number>;
}

/** The stored state of a rack: its slots, in signal order. */
export interface EffectsSnapshot {
    slots: EffectSlotSnapshot[];
}

/**
 * A rack as it was stored before slots: every effect always in the chain, "on" whenever it was not neutral. Session
 * files, history and tests may still hand one in; `Effects.restore` converts it (see `slotsFromLegacy`).
 */
export interface LegacyEffectsSnapshot {
    order: EffectKey[];
    params: Record<EffectKey, Record<string, number>>;
}

/** A slot as the UI sees it. */
export interface EffectSlotInfo {
    readonly id: string;
    readonly effect: EffectKey;
    readonly bypassed: boolean;
}

export const isLegacySnapshot = (snapshot: EffectsSnapshot | LegacyEffectsSnapshot): snapshot is LegacyEffectsSnapshot => 'order' in snapshot;

/**
 * The params of a stored legacy snapshot, brought up to date. Snapshots from before the limiter had an on/off switch
 * have no `limiter.on`; their limiter was always active, so it restores switched on and the session sounds as it did.
 */
export const upgradeEffectParams = (params: Partial<LegacyEffectsSnapshot['params']>): Partial<LegacyEffectsSnapshot['params']> => ({
    ...params,
    limiter: { ...params.limiter, on: params.limiter?.on ?? 1 },
});

/**
 * The slots a legacy rack becomes: every effect that changed the sound, in its old order. A slot's id is its effect's
 * key, so the old automation addresses (`fx.reverb.wet`) and MIDI mappings keep pointing at it.
 */
export const slotsFromLegacy = (snapshot: LegacyEffectsSnapshot, role: EffectRackRole = 'track'): EffectSlotSnapshot[] => {
    const params = upgradeEffectParams(snapshot.params);
    const order = [...snapshot.order.filter((key) => EFFECT_KEYS.includes(key)), ...EFFECT_KEYS.filter((key) => !snapshot.order.includes(key))];
    return order
        .map((effect) => ({ effect, params: { ...initialParams(effect, role), ...params[effect] } }))
        .filter(({ effect, params }) => isEffectNeeded(effect, params))
        .map(({ effect, params }) => ({ id: effect, effect, bypassed: false, params }));
};

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

/** Signal flow order the rack had before slots; legacy snapshots and tests still use it. */
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

/** The automation address of a slot's parameter: `fx.<slot id>.<param>`. */
export const effectParamKey = (slotId: string, param: string): string => `${PARAM_PREFIX}${slotId}.${param}`;

/** The slot id and param of an automation address, or null for any other key. */
export const parseEffectParamKey = (key: string): { slotId: string; param: string } | null => {
    if (!key.startsWith(PARAM_PREFIX)) {
        return null;
    }
    const rest = key.slice(PARAM_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    return dot > 0 ? { slotId: rest.slice(0, dot), param: rest.slice(dot + 1) } : null;
};

/** The automatable params of one slot, as automation sees them. `label` names the device (`Reverb`, `Reverb 2`). */
const slotParams = (slotId: string, effect: EffectKey, label: string): AutomationParam[] =>
    (EFFECT_DEFINITIONS[effect].params as readonly EffectParamDefinition[])
        .filter((param) => param.automatable !== false)
        .map((param) => ({
            key: effectParamKey(slotId, param.key),
            label: param.label,
            group: label,
            min: param.min,
            max: param.max,
            step: param.step,
            curve: param.curve,
            format: param.format,
        }));

interface Slot {
    readonly id: string;
    readonly effect: EffectKey;
    bypassed: boolean;
    readonly params: Record<string, number>;
}

/**
 * An effect chain. Every track has one, so does every container bus, every return and the master.
 *
 * The chain is a list of slots: effects the user added, in signal order, each with its own values. The same effect may
 * sit in several slots (two EQs). A slot can be bypassed: its values stay, the sound passes by.
 *
 * Nodes are only created while a slot is heard: not bypassed and not neutral (a mix above zero, a compressor above
 * 1:1, a switched-on limiter, an EQ that is not flat). A convolution reverb and a handful of LFOs per track are
 * expensive even when they have nothing to do, so an idle slot costs nothing.
 *
 * Parameters are addressed as `fx.<slot id>.<param>` for automation and MIDI learn. A slot's id is its effect's key
 * when that is still free in the rack (`reverb`), else the key and a number (`reverb2`); racks converted from before
 * slots use the effect keys, so old automation keeps its target.
 *
 * The rack is not reactive (it owns Tone nodes); `revision` is, and changes whenever the slot list does.
 */
export class Effects {
    private readonly nodes = new Map<string, ToneAudioNode>();
    private slots: Slot[] = [];

    private source: ToneAudioNode | null = null;
    private destination: ToneAudioNode | null = null;

    /** While suspended the rack has no nodes at all and the sound passes straight through; see `suspend`. */
    private isSuspended = false;

    /** Bumped whenever slots are added, removed, moved or bypassed. Reactive, so views depending on the chain re-render. */
    private readonly changes = shallowRef(0);

    /** Bumped when a slot starts or stops changing the sound through its values (a mix turned up from zero). */
    private readonly activity = shallowRef(0);

    private table: ParameterTable | null = null;

    /**
     * The values of a legacy rack's effects that were left out when it became slots (they did nothing), so an automation
     * lane or a MIDI mapping that still drives one can bring it back (`ensureLegacySlots`).
     */
    private legacy: { order: EffectKey[]; params: Partial<LegacyEffectsSnapshot['params']> } | null = null;

    /** Where the rack sits; decides the values it starts with. */
    readonly role: EffectRackRole;

    constructor({ role = 'track' }: { role?: EffectRackRole } = {}) {
        this.role = role;
        // The master starts with its safety limiter; every other rack starts empty.
        if (role === 'master') {
            this.slots.push({ id: 'limiter', effect: 'limiter', bypassed: false, params: initialParams('limiter', role) });
            this.createNode(this.slots[0]!);
        }
    }

    /** Reactive: read it to re-render when the chain changes, or when a slot starts or stops doing something. */
    get revision(): number {
        return this.changes.value + this.activity.value;
    }

    get chain(): readonly EffectSlotInfo[] {
        return this.slots.map(({ id, effect, bypassed }) => ({ id, effect, bypassed }));
    }

    get size(): number {
        return this.slots.length;
    }

    /** The label of a slot: its effect's name, numbered when the effect is in the chain more than once. */
    slotLabel(id: string): string {
        const slot = this.slot(id);
        if (!slot) {
            return '';
        }
        const same = this.slots.filter((other) => other.effect === slot.effect);
        const label = EFFECT_DEFINITIONS[slot.effect].label;
        return same.length > 1 ? `${label} ${same.indexOf(slot) + 1}` : label;
    }

    /** Whether the slot currently has a node in the chain. */
    isActive(id: string): boolean {
        return this.nodes.has(id);
    }

    /** Whether the slot changes the sound (it is not bypassed and not neutral). The UI lights a slot by this. */
    isNeeded(id: string): boolean {
        const slot = this.slot(id);
        return !!slot && this.slotIsNeeded(slot);
    }

    /** Whether the slot's values are neutral, so it would do nothing even when not bypassed. */
    isIdle(id: string): boolean {
        const slot = this.slot(id);
        return !!slot && !isEffectNeeded(slot.effect, slot.params);
    }

    /** Routes `source -> effects -> destination`. Existing connections of both ends are dropped first. */
    connect(source: ToneAudioNode, destination: ToneAudioNode): void {
        destination.disconnect();
        this.source = source;
        this.destination = destination;
        this.rewire();
    }

    /* ---- the chain ---- */

    /** Adds an effect at `index` (the end by default), with values that are heard right away. Returns the slot id. */
    add(effect: EffectKey, index = this.slots.length, params?: Readonly<Record<string, number>>): string {
        const slot: Slot = { id: this.freeId(effect), effect, bypassed: false, params: { ...addedParams(effect, this.role), ...params } };
        this.slots.splice(Math.max(0, Math.min(this.slots.length, index)), 0, slot);
        this.changed();
        if (!this.isSuspended && this.slotIsNeeded(slot)) {
            this.createNode(slot);
        }
        return slot.id;
    }

    /** A copy of a slot, right after it. Returns the new slot id. */
    duplicate(id: string): string | null {
        const index = this.slots.findIndex((slot) => slot.id === id);
        const slot = this.slots[index];
        if (!slot) {
            return null;
        }
        const copy = this.add(slot.effect, index + 1, slot.params);
        this.setBypassed(copy, slot.bypassed);
        return copy;
    }

    remove(id: string): void {
        const index = this.slots.findIndex((slot) => slot.id === id);
        if (index === -1) {
            return;
        }
        this.slots.splice(index, 1);
        this.destroyNode(id);
        this.changed();
    }

    /** Moves a slot to a position in the chain (clamped). */
    moveTo(id: string, index: number): void {
        const from = this.slots.findIndex((slot) => slot.id === id);
        if (from === -1) {
            return;
        }
        const [slot] = this.slots.splice(from, 1);
        this.slots.splice(Math.max(0, Math.min(this.slots.length, index)), 0, slot!);
        this.changed();
        this.rewire();
    }

    /** Moves a slot one position towards the source (`-1`) or towards the output (`1`). */
    move(id: string, direction: 1 | -1): void {
        const from = this.slots.findIndex((slot) => slot.id === id);
        if (from !== -1) {
            this.moveTo(id, from + direction);
        }
    }

    /** Replaces the order of the chain by slot ids. Ids that are missing keep their relative position at the end. */
    setOrder(ids: readonly string[]): void {
        const known = ids.map((id) => this.slot(id)).filter((slot): slot is Slot => !!slot);
        this.slots = [...new Set([...known, ...this.slots])];
        this.changed();
        this.rewire();
    }

    setBypassed(id: string, bypassed: boolean): void {
        const slot = this.slot(id);
        if (!slot || slot.bypassed === bypassed) {
            return;
        }
        slot.bypassed = bypassed;
        this.changed();
        this.sync(slot);
    }

    isBypassed(id: string): boolean {
        return this.slot(id)?.bypassed ?? false;
    }

    /** Puts every parameter of a slot back to the values it was added with (the master's limiter back to on). */
    reset(id: string): void {
        const slot = this.slot(id);
        if (slot) {
            this.setParams(id, addedParams(slot.effect, this.role));
        }
    }

    /** Removes every slot. */
    clear(): void {
        for (const slot of [...this.slots]) {
            this.remove(slot.id);
        }
    }

    effectOf(id: string): EffectKey | undefined {
        return this.slot(id)?.effect;
    }

    getParam(id: string, param: string): number {
        return this.slot(id)?.params[param] ?? 0;
    }

    /** A copy of a slot's values, for presets. */
    paramsOf(id: string): Record<string, number> {
        return { ...this.slot(id)?.params };
    }

    setParam(id: string, param: string, value: number): void {
        const slot = this.slot(id);
        if (slot) {
            this.apply(slot, param, value);
        }
    }

    /** Several params of one slot at once. */
    setParams(id: string, params: Readonly<Record<string, number>>): void {
        const slot = this.slot(id);
        if (!slot) {
            return;
        }
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && key in EFFECT_PARAM_KEYS[slot.effect]) {
                this.apply(slot, key, value);
            }
        }
    }

    /* ---- automation ---- */

    /** Every automatable parameter of the slots, in chain order. */
    get parameters(): readonly AutomationParam[] {
        // Read for its side effect: a view listing the parameters re-renders when the chain changes.
        void this.changes.value;
        return this.parameterTable().list;
    }

    parameter(key: string): AutomationParam | undefined {
        return this.parameterTable().byKey.get(key);
    }

    /** Reads a parameter by its automation address (`fx.<slot>.<param>`). */
    getParameter(key: string): number {
        const address = parseEffectParamKey(key);
        return address ? (this.slot(address.slotId)?.params[address.param] ?? 0) : 0;
    }

    /**
     * Sets a parameter by its automation address. With a `time` the value is only played, not stored:
     * automation moves the sound, the knob keeps what the user set, and `settle` brings the sound back to it.
     */
    setParameter(key: string, value: number, time?: number): void {
        const address = parseEffectParamKey(key);
        const slot = address && this.slot(address.slotId);
        if (!slot) {
            return;
        }
        if (time === undefined) {
            this.apply(slot, address.param, value);
        } else {
            this.applyLive(slot, address.param, value, time);
        }
    }

    /** Puts the stored value of a parameter back on its node, after automation moved it. */
    settle(key: string): void {
        const address = parseEffectParamKey(key);
        const slot = address && this.slot(address.slotId);
        if (slot) {
            this.apply(slot, address.param, slot.params[address.param] ?? 0);
        }
    }

    /**
     * Brings back the effects of a converted legacy rack that `keys` (automation addresses) still drive. They were left
     * out because they did nothing; a lane fading a dry reverb in needs its slot. Keys of other racks are ignored.
     */
    ensureLegacySlots(keys: Iterable<string>): void {
        const legacy = this.legacy;
        if (!legacy) {
            return;
        }
        for (const key of keys) {
            const address = parseEffectParamKey(key);
            const effect = address?.slotId as EffectKey | undefined;
            if (!effect || !EFFECT_KEYS.includes(effect) || this.slot(effect)) {
                continue;
            }
            // In its old place: after the last slot that came before it in the legacy order.
            const before = legacy.order.slice(0, legacy.order.indexOf(effect));
            let index = 0;
            this.slots.forEach((slot, position) => {
                if (before.includes(slot.id as EffectKey)) {
                    index = position + 1;
                }
            });
            const slot: Slot = { id: effect, effect, bypassed: false, params: { ...initialParams(effect, this.role), ...legacy.params[effect] } };
            this.slots.splice(index, 0, slot);
            this.changed();
            this.sync(slot);
        }
    }

    capture(): EffectsSnapshot {
        return { slots: this.slots.map((slot) => ({ id: slot.id, effect: slot.effect, bypassed: slot.bypassed, params: { ...slot.params } })) };
    }

    /** Takes a stored rack back; a rack stored before slots is converted (see `slotsFromLegacy`). */
    restore(snapshot: EffectsSnapshot | LegacyEffectsSnapshot): void {
        let slots: EffectSlotSnapshot[];
        if (isLegacySnapshot(snapshot)) {
            slots = slotsFromLegacy(snapshot, this.role);
            this.legacy = { order: [...snapshot.order], params: upgradeEffectParams(snapshot.params) };
        } else {
            slots = snapshot.slots.filter((slot) => EFFECT_KEYS.includes(slot.effect));
            this.legacy = null;
        }
        this.restoreSlots(slots);
    }

    /** Copies the chain and every value from another rack. Slot ids are kept, so copied automation keeps its targets. */
    copyFrom(other: Effects): void {
        this.restoreSlots(other.capture().slots);
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
        for (const slot of this.slots) {
            if (this.slotIsNeeded(slot)) {
                this.nodes.set(slot.id, this.buildNode(slot));
            }
        }
        this.rewire();
    }

    /**
     * Seconds the rack keeps sounding after its input fell silent: a reverb's decay and pre-delay, a delay's repeats.
     * Counts every slot that has a node or should have one, at the larger of its stored and its live delay time.
     */
    tail(): number {
        let seconds = 0;
        for (const slot of this.slots) {
            const node = this.nodes.get(slot.id);
            if (!node && !this.slotIsNeeded(slot)) {
                continue;
            }
            if (slot.effect === 'reverb') {
                seconds += (slot.params.decay ?? 0) + (slot.params.preDelay ?? 0);
            } else if (slot.effect === 'delay') {
                const delay = node as FeedbackDelay | undefined;
                const time = Math.max(slot.params.delayTime ?? 0, delay ? delay.toSeconds(delay.delayTime.value) : 0);
                seconds += time * DELAY_REPEATS;
            }
        }
        return seconds;
    }

    /** The node of a slot while it exists, for meters (gain reduction). Never connect or dispose it. */
    nodeOf(id: string): ToneAudioNode | undefined {
        return this.nodes.get(id);
    }

    dispose(): void {
        for (const node of this.nodes.values()) {
            node.dispose();
        }
        this.nodes.clear();
    }

    /* ---- internals ---- */

    private slot(id: string): Slot | undefined {
        for (let i = 0; i < this.slots.length; i++) {
            if (this.slots[i]!.id === id) {
                return this.slots[i];
            }
        }
        return undefined;
    }

    /** The effect's key if no slot has it, else the key and the lowest free number from 2. */
    private freeId(effect: EffectKey): string {
        if (!this.slot(effect)) {
            return effect;
        }
        let n = 2;
        while (this.slot(`${effect}${n}`)) {
            n++;
        }
        return `${effect}${n}`;
    }

    private changed(): void {
        this.table = null;
        this.changes.value++;
    }

    private parameterTable(): ParameterTable {
        return (this.table ??= createParameterTable(this.slots.flatMap((slot) => slotParams(slot.id, slot.effect, this.slotLabel(slot.id)))));
    }

    private slotIsNeeded(slot: Slot, params: Readonly<Record<string, number>> = slot.params): boolean {
        return !slot.bypassed && isEffectNeeded(slot.effect, params);
    }

    private restoreSlots(slots: readonly EffectSlotSnapshot[]): void {
        // Slots that stay keep their nodes (a reverb need not render again); the rest go.
        const next: Slot[] = slots.map((stored) => {
            const existing = this.slot(stored.id);
            if (existing && existing.effect === stored.effect) {
                return existing;
            }
            return { id: stored.id, effect: stored.effect, bypassed: stored.bypassed, params: { ...initialParams(stored.effect, this.role) } };
        });
        for (const slot of this.slots) {
            if (!next.includes(slot)) {
                this.destroyNode(slot.id);
            }
        }
        this.slots = next;
        slots.forEach((stored, index) => {
            const slot = next[index]!;
            slot.bypassed = stored.bypassed;
            for (const [param, value] of Object.entries(stored.params)) {
                slot.params[param] = value;
            }
            this.sync(slot, true);
        });
        this.changed();
        this.rewire();
    }

    /** Creates or removes a slot's node to match whether it is heard; pushes every value to an existing node when asked. */
    private sync(slot: Slot, pushValues = false): void {
        if (this.isSuspended) {
            return;
        }
        const shouldExist = this.slotIsNeeded(slot);
        const node = this.nodes.get(slot.id);
        if (shouldExist && !node) {
            this.createNode(slot);
        } else if (!shouldExist && node) {
            this.destroyNode(slot.id);
        } else if (node && pushValues) {
            for (const [param, value] of Object.entries(slot.params)) {
                this.applyParam(node, slot.effect, param, value, false);
            }
        }
    }

    /** Stores a value and pushes it to the node. The node comes and goes with the slot being heard. */
    private apply(slot: Slot, param: string, value: number): void {
        slot.params[param] = value;
        if (this.isSuspended) {
            return;
        }
        const node = this.nodes.get(slot.id);
        const shouldExist = this.slotIsNeeded(slot);
        if (shouldExist && !node) {
            this.createNode(slot);
            this.activity.value++;
        } else if (!shouldExist && node) {
            this.destroyNode(slot.id);
            this.activity.value++;
        } else if (node) {
            this.applyParam(node, slot.effect, param, value, true);
        }
    }

    /**
     * Plays a value at a time without storing it. A node that does not exist yet is created when the value, put
     * over the stored ones, would make the slot audible (a mix above zero, a neutral compressor's ratio above 1).
     * It is never thrown away here: automation sweeping through zero every bar must not rebuild a reverb every bar.
     */
    private applyLive(slot: Slot, param: string, value: number, time: number): void {
        let node = this.nodes.get(slot.id);
        if (!node) {
            if (this.isSuspended || !this.slotIsNeeded(slot, { ...slot.params, [param]: value })) {
                return;
            }
            node = this.createNode(slot);
        }
        this.applyParam(node, slot.effect, param, value, true, time);
    }

    private createNode(slot: Slot): ToneAudioNode {
        const node = this.buildNode(slot);
        this.nodes.set(slot.id, node);
        this.rewire();
        return node;
    }

    /** A new node for a slot with its stored values on it; not wired yet. */
    private buildNode(slot: Slot): ToneAudioNode {
        const node = FACTORIES[slot.effect]();
        for (const [param, value] of Object.entries(slot.params)) {
            this.applyParam(node, slot.effect, param, value, false);
        }
        return node;
    }

    private destroyNode(id: string): void {
        const node = this.nodes.get(id);
        if (!node) {
            return;
        }
        this.nodes.delete(id);
        this.rewire();
        node.dispose();
    }

    private applyParam(node: ToneAudioNode, effect: EffectKey, param: string, value: number, ramp = true, time?: number): void {
        const definition = (EFFECT_DEFINITIONS[effect].params as readonly EffectParamDefinition[]).find((p) => p.key === param);
        if (!definition || definition.toggle) {
            // A switch only decides whether the node exists (`apply`); the node has no such property.
            return;
        }
        const target = (node as unknown as Record<string, unknown>)[param];

        if (isValueHolder(target)) {
            if (time !== undefined && target.rampTo) {
                target.rampTo(value, definition.ramp ?? AUTOMATION_RAMP, time);
            } else if (ramp && definition.ramp && target.rampTo) {
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

        const active: ToneAudioNode[] = [];
        for (const slot of this.slots) {
            const node = this.nodes.get(slot.id);
            if (node) {
                active.push(node);
            }
        }
        connectSeries(this.source, ...active, this.destination);
    }
}

/** The param keys of every effect, as a set-like record, so `setParams` skips keys an effect does not have. */
const EFFECT_PARAM_KEYS = Object.fromEntries(
    EFFECT_KEYS.map((effect) => [effect, Object.fromEntries((EFFECT_DEFINITIONS[effect].params as readonly EffectParamDefinition[]).map((param) => [param.key, true]))]),
) as Record<EffectKey, Record<string, true>>;
