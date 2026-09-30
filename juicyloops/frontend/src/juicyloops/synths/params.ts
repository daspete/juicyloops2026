import type { AutomationParam } from '../automation';

/**
 * The synth models and their parameters.
 *
 * `classic` is the original one-oscillator synth (its settings live on `SynthTrack` itself). `analog`, `wavetable`
 * and `fm` run on the Rust `Instrument` engine, whose settings are one flat patch addressed by numeric id
 * (`juicyloops/dsp/crates/core/src/instrument/params.rs`; the ids here must match it). `plugin` is a WAM 2.0
 * instrument (see `../plugins`).
 *
 * Every patch parameter has a key (`patch.filter.cutoff`), which is what automation, MIDI learn, presets and saved
 * sessions use; the id only travels to the engine.
 */
export type SynthModel = 'classic' | 'analog' | 'wavetable' | 'fm' | 'plugin';

/** The models that run on the Rust `Instrument`. */
export type PatchModel = 'analog' | 'wavetable' | 'fm';

export const SYNTH_MODELS: readonly SynthModel[] = ['classic', 'analog', 'wavetable', 'fm', 'plugin'];

export const isPatchModel = (model: SynthModel): model is PatchModel => model === 'analog' || model === 'wavetable' || model === 'fm';

/** How each model presents itself. */
export const MODEL_META: Record<SynthModel, { label: string; icon: string; blurb: string }> = {
    classic: { label: 'Classic', icon: 'mdi:sine-wave', blurb: 'One oscillator and an envelope. Light and simple.' },
    analog: { label: 'Analog', icon: 'mdi:sawtooth-wave', blurb: 'Three oscillators, unison, a resonant filter, two LFOs and a mod matrix.' },
    wavetable: { label: 'Wavetable', icon: 'mdi:waveform', blurb: 'Two morphing wavetable oscillators through the same filter and modulation.' },
    fm: { label: 'FM', icon: 'mdi:chart-bell-curve-cumulative', blurb: 'Four operators, eight algorithms: bells, electric pianos, metallic basses.' },
    plugin: { label: 'Plugin', icon: 'mdi:puzzle-outline', blurb: 'A Web Audio Module instrument, loaded from the web.' },
};

/** The worklet's engine kind per model (`init(sample_rate, kind)`). */
export const ENGINE_KIND: Record<'classic' | PatchModel, number> = { classic: 0, analog: 1, wavetable: 2, fm: 3 };

/** A patch parameter: an automation parameter with its engine id, default and, for a choice, its options. */
export interface PatchParam extends AutomationParam {
    id: number;
    default: number;
    hint?: string;
    /** A choice between named values 0..options.length-1; shown as a picker, not a knob, and not automatable. */
    options?: readonly string[];
}

/** Values of a patch, by parameter key. */
export type PatchValues = Record<string, number>;

/* ---- engine ids (params.rs) ---- */

export const PatchId = {
    volume: 0,
    glide: 1,
    velocity: 2,
    bend: 3,
    modWheel: 4,
    tempo: 5,
    unison: 6,
    unisonDetune: 7,
    unisonSpread: 8,
    pan: 9,
    osc: 10,
    oscStride: 6,
    noise: 28,
    sub: 29,
    fmAlgorithm: 10,
    fmFeedback: 11,
    op: 100,
    opStride: 10,
    filterType: 40,
    cutoff: 41,
    resonance: 42,
    drive: 43,
    keyTrack: 44,
    filterEnv: 45,
    filterVelocity: 46,
    filterAttack: 50,
    ampAttack: 54,
    lfo: 60,
    lfoStride: 10,
    matrix: 80,
} as const;

/* ---- formatting ---- */

const seconds = (value: number) => (value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`);
const percent = (value: number) => `${Math.round(value * 100)}%`;
const signedPercent = (value: number) => (Math.abs(value) < 0.005 ? '0%' : `${value > 0 ? '+' : '−'}${Math.round(Math.abs(value) * 100)}%`);
const hertz = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}kHz` : `${value < 10 ? value.toFixed(2) : Math.round(value)}Hz`);
const signed = (unit: string) => (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(Math.round(value))}${unit}`;
const ratio = (value: number) => `×${value < 10 ? value.toFixed(2) : value.toFixed(1)}`;
const pan = (value: number) => (Math.abs(value) < 0.005 ? 'C' : `${Math.round(Math.abs(value) * 100)}${value < 0 ? 'L' : 'R'}`);
const count = (value: number) => `${Math.round(value)}`;

/* ---- choices ---- */

export const ANALOG_WAVES = ['Sine', 'Triangle', 'Saw', 'Pulse'] as const;
/** The built-in wavetables, in engine order (`wavetable.rs`). */
export const WAVETABLES = ['Basic', 'PWM', 'Organ', 'Vox', 'Sync', 'Fold', 'Bell', 'Growl'] as const;
export const FILTER_TYPES = ['Off', 'Low-pass 24', 'Low-pass 12', 'Band-pass', 'High-pass', 'Notch'] as const;
export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw up', 'Saw down', 'Square', 'Random'] as const;
/** Index 0 is free-running (rate in Hz); the others are note lengths (`SYNC_BEATS` in `lfo.rs`). */
export const LFO_SYNCS = ['Free', '2/1', '1/1', '1/2', '1/4.', '1/4', '1/4T', '1/8.', '1/8', '1/8T', '1/16.', '1/16', '1/16T', '1/32'] as const;
export const MOD_SOURCES = ['None', 'LFO 1', 'LFO 2', 'Filter env', 'Amp env', 'Velocity', 'Mod wheel', 'Key', 'Random'] as const;
/** The TX81Z algorithms (`fm.rs`): which operator modulates which; the ones reaching the output are the carriers. */
export const FM_ALGORITHMS = ['1: 4→3→2→1', '2: 3+4→2→1', '3: 3→2→1, 4→1', '4: 4→3→1, 2→1', '5: 2→1, 4→3', '6: 4→1, 2, 3', '7: 4→3, 1, 2', '8: 1+2+3+4'] as const;

/** Destination names per model (engine `Dest` order: A and B are the first two oscillators). */
export const modDestinations = (model: PatchModel): readonly string[] => {
    const [pitchA, pitchB, shapeA, shapeB, levelB] =
        model === 'fm'
            ? ['Modulator pitch', 'Op 4 pitch', 'Brightness', 'Feedback', 'Carrier level']
            : model === 'wavetable'
              ? ['Osc 1 pitch', 'Osc 2 pitch', 'Osc 1 position', 'Osc 2 position', 'Osc 2 level']
              : ['Osc 1 pitch', 'Osc 2 pitch', 'Osc 1 width', 'Osc 2 width', 'Osc 2 level'];
    return ['None', 'Pitch', pitchA, pitchB, shapeA, shapeB, 'Cutoff', 'Resonance', 'Volume', 'Pan', 'LFO 1 rate', 'LFO 2 rate', 'Noise', levelB, 'Drive'];
};

/** Destination numbers the presets use. */
export const Dest = { none: 0, pitch: 1, pitchA: 2, pitchB: 3, shapeA: 4, shapeB: 5, cutoff: 6, resonance: 7, volume: 8, pan: 9, lfo1Rate: 10, lfo2Rate: 11, noise: 12, levelB: 13, drive: 14 } as const;
export const Source = { none: 0, lfo1: 1, lfo2: 2, filterEnv: 3, ampEnv: 4, velocity: 5, modWheel: 6, key: 7, random: 8 } as const;

/* ---- building the tables ---- */

type ParamSpec = Omit<PatchParam, 'key' | 'group' | 'step'> & { step?: number };

const make = (key: string, group: string, spec: ParamSpec): PatchParam => ({
    step: spec.options ? 1 : 0.001,
    ...spec,
    key: `patch.${key}`,
    group,
});

const choice = (key: string, group: string, id: number, label: string, options: readonly string[], value = 0, hint?: string): PatchParam =>
    make(key, group, { id, label, min: 0, max: options.length - 1, step: 1, default: value, options, hint, format: (v) => options[Math.round(v)] ?? '' });

const envelope = (prefix: string, group: string, base: number, defaults: [number, number, number, number]): PatchParam[] => [
    make(`${prefix}.attack`, group, { id: base, label: 'Attack', min: 0.001, max: 5, curve: 'log', format: seconds, default: defaults[0] }),
    make(`${prefix}.decay`, group, { id: base + 1, label: 'Decay', min: 0.005, max: 5, curve: 'log', format: seconds, default: defaults[1] }),
    make(`${prefix}.sustain`, group, { id: base + 2, label: 'Sustain', min: 0, max: 1, step: 0.01, format: percent, default: defaults[2] }),
    make(`${prefix}.release`, group, { id: base + 3, label: 'Release', min: 0.005, max: 8, curve: 'log', format: seconds, default: defaults[3] }),
];

const tuning = (prefix: string, group: string, base: number): PatchParam[] => [
    make(`${prefix}.octave`, group, { id: base + 1, label: 'Octave', min: -3, max: 3, step: 1, format: signed(''), default: 0, hint: 'Octaves up or down' }),
    make(`${prefix}.semi`, group, { id: base + 2, label: 'Semi', min: -12, max: 12, step: 1, format: signed('st'), default: 0, hint: 'Semitones up or down' }),
    make(`${prefix}.fine`, group, { id: base + 3, label: 'Fine', min: -100, max: 100, step: 1, format: signed('ct'), default: 0, hint: 'Cents up or down' }),
];

const globals = (model: PatchModel): PatchParam[] => [
    make('volume', 'Voice', { id: PatchId.volume, label: 'Volume', min: 0, max: 1, step: 0.01, format: percent, default: 0.7 }),
    make('pan', 'Voice', { id: PatchId.pan, label: 'Pan', min: -1, max: 1, step: 0.01, format: pan, default: 0 }),
    make('glide', 'Voice', { id: PatchId.glide, label: 'Glide', min: 0, max: 1, step: 0.001, format: (v) => (v <= 0 ? 'Off' : seconds(v)), default: 0, hint: 'Slides from the last note to the next one' }),
    make('velocity', 'Voice', { id: PatchId.velocity, label: 'Velocity', min: 0, max: 1, step: 0.01, format: percent, default: 1, hint: 'How much harder notes play louder' }),
    make('modWheel', 'Voice', { id: PatchId.modWheel, label: 'Mod wheel', min: 0, max: 1, step: 0.01, format: percent, default: 0, hint: 'A modulation source you can route in the matrix; the MIDI mod wheel moves it' }),
    ...(model === 'fm'
        ? []
        : [
              make('unison', 'Voice', { id: PatchId.unison, label: 'Unison', min: 1, max: 7, step: 1, format: count, default: 1, hint: 'Detuned copies of every oscillator' }),
              make('detune', 'Voice', { id: PatchId.unisonDetune, label: 'Detune', min: 0, max: 1, step: 0.01, format: percent, default: 0.2, hint: 'How far apart the unison copies are tuned' }),
              make('spread', 'Voice', { id: PatchId.unisonSpread, label: 'Spread', min: 0, max: 1, step: 0.01, format: percent, default: 0.5, hint: 'How wide the unison copies spread across the stereo field' }),
          ]),
];

const filter = (model: PatchModel): PatchParam[] => [
    choice('filter.type', 'Filter', PatchId.filterType, 'Type', FILTER_TYPES, model === 'fm' ? 0 : 1),
    make('filter.cutoff', 'Filter', { id: PatchId.cutoff, label: 'Cutoff', min: 20, max: 20000, curve: 'log', step: 0.1, format: hertz, default: 20000, hint: 'Where the filter starts to cut' }),
    make('filter.resonance', 'Filter', { id: PatchId.resonance, label: 'Reso', min: 0, max: 1, step: 0.01, format: percent, default: 0, hint: 'Emphasis at the cutoff; near the top it rings' }),
    make('filter.drive', 'Filter', { id: PatchId.drive, label: 'Drive', min: 0, max: 1, step: 0.01, format: percent, default: 0, hint: 'Saturation in front of the filter' }),
    make('filter.env', 'Filter', { id: PatchId.filterEnv, label: 'Env amt', min: -1, max: 1, step: 0.01, format: signedPercent, default: 0, hint: 'How far the filter envelope moves the cutoff' }),
    make('filter.keyTrack', 'Filter', { id: PatchId.keyTrack, label: 'Key track', min: 0, max: 1, step: 0.01, format: percent, default: 0, hint: 'Higher notes open the filter further' }),
    make('filter.velocity', 'Filter', { id: PatchId.filterVelocity, label: 'Vel amt', min: 0, max: 1, step: 0.01, format: percent, default: 0, hint: 'Softer notes play darker' }),
    ...envelope('filterEnv', 'Filter envelope', PatchId.filterAttack, [0.005, 0.3, 0.5, 0.3]),
];

const lfo = (model: PatchModel, n: 1 | 2): PatchParam[] => {
    const base = PatchId.lfo + (n - 1) * PatchId.lfoStride;
    const group = `LFO ${n}`;
    return [
        choice(`lfo${n}.shape`, group, base, 'Shape', LFO_SHAPES),
        make(`lfo${n}.rate`, group, { id: base + 1, label: 'Rate', min: 0.02, max: 40, curve: 'log', step: 0.01, format: hertz, default: n === 1 ? 5 : 0.5 }),
        choice(`lfo${n}.sync`, group, base + 2, 'Sync', LFO_SYNCS, 0, 'Free in Hz, or a note length at the song tempo'),
        choice(`lfo${n}.retrigger`, group, base + 3, 'Mode', ['Free', 'Per note'], 1, 'Per note: every note starts the cycle over'),
        choice(`lfo${n}.dest`, group, base + 4, 'Target', modDestinations(model)),
        make(`lfo${n}.amount`, group, { id: base + 5, label: 'Amount', min: -1, max: 1, step: 0.001, format: signedPercent, default: 0 }),
        make(`lfo${n}.fade`, group, { id: base + 6, label: 'Fade in', min: 0, max: 5, step: 0.01, format: (v) => (v <= 0 ? 'Off' : seconds(v)), default: 0, hint: 'Per-note LFOs fade in over this time' }),
    ];
};

const matrix = (model: PatchModel): PatchParam[] =>
    [1, 2, 3, 4].flatMap((slot) => {
        const base = PatchId.matrix + (slot - 1) * 3;
        const group = 'Matrix';
        return [
            choice(`mod${slot}.source`, group, base, `Source ${slot}`, MOD_SOURCES),
            choice(`mod${slot}.dest`, group, base + 1, `Target ${slot}`, modDestinations(model)),
            make(`mod${slot}.amount`, group, { id: base + 2, label: `Amount ${slot}`, min: -1, max: 1, step: 0.001, format: signedPercent, default: 0 }),
        ];
    });

const analogOscillators = (): PatchParam[] =>
    [1, 2, 3].flatMap((n) => {
        const base = PatchId.osc + (n - 1) * PatchId.oscStride;
        const group = `Osc ${n}`;
        return [
            choice(`osc${n}.wave`, group, base, 'Wave', ANALOG_WAVES, 2),
            ...tuning(`osc${n}`, group, base),
            make(`osc${n}.level`, group, { id: base + 4, label: 'Level', min: 0, max: 1, step: 0.01, format: percent, default: n === 1 ? 1 : 0 }),
            make(`osc${n}.width`, group, { id: base + 5, label: 'Width', min: 0.05, max: 0.95, step: 0.01, format: percent, default: 0.5, hint: 'Pulse width (pulse wave only)' }),
        ];
    });

const wavetableOscillators = (): PatchParam[] =>
    [1, 2].flatMap((n) => {
        const base = PatchId.osc + (n - 1) * PatchId.oscStride;
        const group = `Osc ${n}`;
        return [
            choice(`osc${n}.table`, group, base, 'Table', WAVETABLES, 0),
            make(`osc${n}.position`, group, { id: base + 5, label: 'Position', min: 0, max: 1, step: 0.001, format: percent, default: 0, hint: 'Where in the table the oscillator plays; sweep it to morph' }),
            ...tuning(`osc${n}`, group, base),
            make(`osc${n}.level`, group, { id: base + 4, label: 'Level', min: 0, max: 1, step: 0.01, format: percent, default: n === 1 ? 1 : 0 }),
        ];
    });

const noiseAndSub = (): PatchParam[] => [
    make('sub', 'Mixer', { id: PatchId.sub, label: 'Sub', min: 0, max: 1, step: 0.01, format: percent, default: 0, hint: 'A square an octave under oscillator 1' }),
    make('noise', 'Mixer', { id: PatchId.noise, label: 'Noise', min: 0, max: 1, step: 0.01, format: percent, default: 0 }),
];

const fmOperators = (): PatchParam[] => [
    choice('fm.algorithm', 'Operators', PatchId.fmAlgorithm, 'Algorithm', FM_ALGORITHMS, 0, 'How the operators modulate each other'),
    make('fm.feedback', 'Operators', { id: PatchId.fmFeedback, label: 'Feedback', min: 0, max: 1, step: 0.01, format: percent, default: 0, hint: 'Operator 4 modulating itself: from bright to noisy' }),
    ...[1, 2, 3, 4].flatMap((n) => {
        const base = PatchId.op + (n - 1) * PatchId.opStride;
        const group = `Op ${n}`;
        return [
            make(`op${n}.ratio`, group, { id: base, label: 'Ratio', min: 0.25, max: 16, step: 0.01, curve: 'log', format: ratio, default: 1, hint: 'Frequency as a multiple of the note' }),
            make(`op${n}.detune`, group, { id: base + 1, label: 'Detune', min: -50, max: 50, step: 1, format: signed('ct'), default: 0 }),
            make(`op${n}.level`, group, { id: base + 2, label: 'Level', min: 0, max: 1, step: 0.01, format: percent, default: n <= 2 ? 1 : 0, hint: 'A carrier’s volume, a modulator’s depth' }),
            ...envelope(`op${n}`, group, base + 3, [0.005, 0.5, n === 1 ? 1 : 0.4, 0.3]),
            make(`op${n}.velocity`, group, { id: base + 7, label: 'Vel', min: 0, max: 1, step: 0.01, format: percent, default: n === 1 ? 0 : 0.5, hint: 'How much velocity sets its level' }),
        ];
    }),
];

const buildParams = (model: PatchModel): readonly PatchParam[] => [
    ...(model === 'analog' ? [...analogOscillators(), ...noiseAndSub()] : model === 'wavetable' ? [...wavetableOscillators(), ...noiseAndSub()] : fmOperators()),
    ...filter(model),
    ...envelope('amp', 'Amp envelope', PatchId.ampAttack, [0.005, 0.1, 0.8, 0.3]),
    ...lfo(model, 1),
    ...lfo(model, 2),
    ...matrix(model),
    ...globals(model),
];

export const PATCH_PARAMS: Record<PatchModel, readonly PatchParam[]> = {
    analog: buildParams('analog'),
    wavetable: buildParams('wavetable'),
    fm: buildParams('fm'),
};

const byKey: Record<PatchModel, Map<string, PatchParam>> = {
    analog: new Map(PATCH_PARAMS.analog.map((param) => [param.key, param])),
    wavetable: new Map(PATCH_PARAMS.wavetable.map((param) => [param.key, param])),
    fm: new Map(PATCH_PARAMS.fm.map((param) => [param.key, param])),
};

export const patchParam = (model: PatchModel, key: string): PatchParam | undefined => byKey[model].get(key);

/** The parameters automation and MIDI learn offer: everything but the choices. */
export const AUTOMATABLE_PATCH_PARAMS: Record<PatchModel, readonly PatchParam[]> = {
    analog: PATCH_PARAMS.analog.filter((param) => !param.options),
    wavetable: PATCH_PARAMS.wavetable.filter((param) => !param.options),
    fm: PATCH_PARAMS.fm.filter((param) => !param.options),
};

/** Every parameter at its default. */
export const defaultPatch = (model: PatchModel): PatchValues => Object.fromEntries(PATCH_PARAMS[model].map((param) => [param.key, param.default]));

/** A value inside its parameter's range (and whole for a choice). */
export const clampPatchValue = (param: PatchParam, value: number): number => {
    const clamped = Math.min(param.max, Math.max(param.min, value));
    return param.options ? Math.round(clamped) : clamped;
};

/**
 * A full patch from stored values: defaults for anything missing (a patch saved by an older version), unknown keys
 * dropped, everything clamped. Keys may be given with or without the `patch.` prefix.
 */
export const normalizePatch = (model: PatchModel, values: Readonly<Record<string, unknown>> | undefined): PatchValues => {
    const patch = defaultPatch(model);
    for (const [rawKey, value] of Object.entries(values ?? {})) {
        const key = rawKey.startsWith('patch.') ? rawKey : `patch.${rawKey}`;
        const param = byKey[model].get(key);
        if (param && typeof value === 'number' && Number.isFinite(value)) {
            patch[key] = clampPatchValue(param, value);
        }
    }
    return patch;
};
