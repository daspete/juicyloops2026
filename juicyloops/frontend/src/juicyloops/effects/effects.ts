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
import { EFFECT_DEFINITIONS, EFFECT_KEYS, type EffectKey, type EffectParamDefinition, type EffectParamKey } from './definitions';

export type { EffectKey, EffectParamKey } from './definitions';

/** Anything with a numeric `value`, i.e. a Tone `Param` or `Signal`. */
interface ValueHolder {
    value: number;
    rampTo?: (value: number, rampTime: number) => unknown;
}

const isValueHolder = (target: unknown): target is ValueHolder => typeof target === 'object' && target !== null && 'value' in target;

const createBitCrusher = (): BitCrusher => {
    const bitCrusher = new BitCrusher(8);
    bitCrusher.wet.value = 0;
    return bitCrusher;
};

/** Signal flow order a fresh track starts with. */
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

/**
 * The per-track effect chain. All effects are always wired in series and start fully dry (`wet = 0`).
 * Parameters are addressed by the keys declared in `EFFECT_DEFINITIONS`, so the UI can stay generic.
 * The order of the chain can be changed at any time; the nodes are re-wired on the spot.
 */
export class Effects {
    readonly nodes: Record<EffectKey, ToneAudioNode> = {
        chorus: new Chorus({ wet: 0 }).start(),
        phaser: new Phaser({ wet: 0 }),
        distortion: new Distortion({ wet: 0 }),
        bitCrusher: createBitCrusher(),
        autoFilter: new AutoFilter({ wet: 0 }).start(),
        tremolo: new Tremolo({ wet: 0 }).start(),
        vibrato: new Vibrato({ wet: 0 }),
        delay: new FeedbackDelay({ wet: 0 }),
        reverb: new Reverb({ wet: 0 }),
        compressor: new Compressor({ threshold: -24, ratio: 12, attack: 0.003, release: 0.25 }),
        equalizer: new EQ3(0, 0, 0),
        limiter: new Limiter(-1),
    };

    /** Current signal flow order, first entry is closest to the sound source. */
    private chain: EffectKey[] = [...DEFAULT_EFFECT_ORDER];

    /** The values every parameter had when the chain was created, used by `reset`. */
    private readonly defaults: Record<EffectKey, Record<string, number>>;

    private source: ToneAudioNode | null = null;
    private destination: ToneAudioNode | null = null;

    constructor() {
        this.defaults = Object.fromEntries(
            EFFECT_KEYS.map((effect) => [
                effect,
                Object.fromEntries(EFFECT_DEFINITIONS[effect].params.map((param) => [param.key, this.getParam(effect, param.key as EffectParamKey<typeof effect>)])),
            ]),
        ) as Record<EffectKey, Record<string, number>>;
    }

    get order(): readonly EffectKey[] {
        return this.chain;
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
        this.setParams(effect, this.defaults[effect] as Partial<Record<EffectParamKey<typeof effect>, number>>);
    }

    /** Drops the outgoing connections of the source and every effect and wires them up again in chain order. */
    private rewire(): void {
        if (!this.source || !this.destination) {
            return;
        }

        this.source.disconnect();
        for (const node of Object.values(this.nodes)) {
            node.disconnect();
        }

        connectSeries(this.source, ...this.chain.map((key) => this.nodes[key]), this.destination);
    }

    getParam<K extends EffectKey>(effect: K, param: EffectParamKey<K>): number {
        const target = this.paramTarget(effect, param);
        return isValueHolder(target) ? target.value : (target as number);
    }

    setParam<K extends EffectKey>(effect: K, param: EffectParamKey<K>, value: number): void {
        const definition = (EFFECT_DEFINITIONS[effect].params as readonly EffectParamDefinition[]).find((p) => p.key === param);
        const target = this.paramTarget(effect, param);

        if (isValueHolder(target)) {
            if (definition?.ramp && target.rampTo) {
                target.rampTo(value, definition.ramp);
            } else {
                target.value = value;
            }
            return;
        }

        (this.nodes[effect] as unknown as Record<string, number>)[param] = value;
    }

    /** Convenience for setting several parameters of one effect at once. */
    setParams<K extends EffectKey>(effect: K, params: Partial<Record<EffectParamKey<K>, number>>): void {
        for (const [key, value] of Object.entries(params) as [EffectParamKey<K>, number | undefined][]) {
            if (value !== undefined) {
                this.setParam(effect, key, value);
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

    dispose(): void {
        for (const node of Object.values(this.nodes)) {
            node.dispose();
        }
    }

    private paramTarget(effect: EffectKey, param: string): unknown {
        return (this.nodes[effect] as unknown as Record<string, unknown>)[param];
    }
}
