/**
 * Declarative description of every effect in the rack.
 *
 * The audio side (`Effects`) uses the keys to address Tone nodes and their parameters,
 * the UI side (`EffectRack`) renders one panel per effect and one knob per parameter.
 * Adding a new parameter means adding one line here (plus the node in `Effects`).
 */
export interface EffectParamDefinition {
    /** Property name on the Tone node. Both plain properties and Signals/Params are supported. */
    key: string;
    label: string;
    min: number;
    max: number;
    step: number;
    /** The value a fresh track starts with. */
    initial: number;
    /** Optional ramp time in seconds. When set the value is ramped instead of jumped. */
    ramp?: number;
    /** How the knob maps its travel to values. `log` suits times and frequencies. */
    curve?: 'linear' | 'log';
    /** Optional display formatter for the knob readout. */
    format?: (value: number) => string;
}

export interface EffectDefinition {
    label: string;
    params: readonly EffectParamDefinition[];
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (value: number) => (value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`);
const hertz = (value: number) => (value < 10 ? `${value.toFixed(2)}Hz` : `${Math.round(value)}Hz`);
const decibel = (value: number) => `${value.toFixed(1)}dB`;

/* Every effect starts fully dry; the other initial values follow Tone's own defaults. */
const wet: EffectParamDefinition = { key: 'wet', label: 'Mix', min: 0, max: 1, step: 0.01, initial: 0, format: percent };
const depth = (initial: number): EffectParamDefinition => ({ key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, initial, format: percent });
const lfoFrequency = (initial: number): EffectParamDefinition => ({
    key: 'frequency',
    label: 'Rate',
    min: 0.1,
    max: 50,
    step: 0.01,
    initial,
    curve: 'log',
    format: hertz,
});

export const EFFECT_DEFINITIONS = {
    autoFilter: { label: 'AutoFilter', params: [wet, depth(1), lfoFrequency(1)] },
    bitCrusher: { label: 'BitCrusher', params: [wet, { key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, initial: 8, format: (v) => `${v}` }] },
    chorus: {
        label: 'Chorus',
        params: [
            wet,
            { key: 'frequency', label: 'Rate', min: 0.1, max: 8, step: 0.01, initial: 1.5, curve: 'log', format: hertz },
            depth(0.7),
            { key: 'delayTime', label: 'Delay', min: 0.1, max: 10, step: 0.01, initial: 3.5, curve: 'log', format: (v) => `${v.toFixed(1)}ms` },
        ],
    },
    compressor: {
        label: 'Compressor',
        params: [
            { key: 'threshold', label: 'Threshold', min: -100, max: 0, step: 0.5, initial: -24, format: decibel },
            { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, initial: 12, format: (v) => `${v.toFixed(1)}:1` },
            { key: 'attack', label: 'Attack', min: 0.001, max: 1, step: 0.001, initial: 0.003, curve: 'log', format: seconds },
            { key: 'release', label: 'Release', min: 0.01, max: 1, step: 0.01, initial: 0.25, curve: 'log', format: seconds },
        ],
    },
    delay: { label: 'Delay', params: [wet, { key: 'delayTime', label: 'Time', min: 0.01, max: 1, step: 0.01, initial: 0.25, curve: 'log', format: seconds }] },
    distortion: { label: 'Distortion', params: [wet, { key: 'distortion', label: 'Drive', min: 0, max: 1, step: 0.01, initial: 0.4, format: percent }] },
    equalizer: {
        label: 'Equalizer',
        params: [
            { key: 'low', label: 'Low', min: -12, max: 12, step: 0.1, initial: 0, format: decibel },
            { key: 'mid', label: 'Mid', min: -12, max: 12, step: 0.1, initial: 0, format: decibel },
            { key: 'high', label: 'High', min: -12, max: 12, step: 0.1, initial: 0, format: decibel },
        ],
    },
    limiter: { label: 'Limiter', params: [{ key: 'threshold', label: 'Ceiling', min: -50, max: 0, step: 0.5, initial: -1, ramp: 0.05, format: decibel }] },
    phaser: {
        label: 'Phaser',
        params: [
            wet,
            { key: 'frequency', label: 'Rate', min: 0.1, max: 2, step: 0.01, initial: 0.5, curve: 'log', format: hertz },
            { key: 'baseFrequency', label: 'Base', min: 20, max: 1000, step: 1, initial: 350, curve: 'log', format: hertz },
            { key: 'octaves', label: 'Octaves', min: 1, max: 8, step: 1, initial: 3, format: (v) => `${v}` },
        ],
    },
    reverb: {
        label: 'Reverb',
        params: [
            wet,
            { key: 'decay', label: 'Decay', min: 0.1, max: 10, step: 0.01, initial: 1.5, curve: 'log', format: seconds },
            { key: 'preDelay', label: 'Pre-delay', min: 0, max: 2, step: 0.01, initial: 0.01, format: seconds },
        ],
    },
    tremolo: { label: 'Tremolo', params: [wet, depth(0.5), lfoFrequency(10)] },
    vibrato: { label: 'Vibrato', params: [wet, depth(0.1), lfoFrequency(5)] },
} as const satisfies Record<string, EffectDefinition>;

export type EffectKey = keyof typeof EFFECT_DEFINITIONS;

/** The parameter names that exist for a given effect, e.g. `EffectParamKey<'chorus'>` is `'wet' | 'frequency' | 'depth' | 'delayTime'`. */
export type EffectParamKey<K extends EffectKey> = (typeof EFFECT_DEFINITIONS)[K]['params'][number]['key'];

export const EFFECT_KEYS = Object.keys(EFFECT_DEFINITIONS) as EffectKey[];

/** The initial value of every parameter of an effect, keyed by parameter. */
export const initialParams = (effect: EffectKey): Record<string, number> =>
    Object.fromEntries(EFFECT_DEFINITIONS[effect].params.map((param) => [param.key, param.initial]));
