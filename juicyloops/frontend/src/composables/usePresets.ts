import { ref, watch } from 'vue';
import { EFFECT_PRESETS, type EffectKey } from '@/juicyloops/effects/definitions';
import type { OscillatorType } from '@/juicyloops/notes';
import type { SynthEnvelope } from '@/juicyloops/tracks/synthEngine';

/**
 * Presets for the device rack: factory presets that ship with the app, and user presets saved from any device.
 *
 * User presets live in the browser (localStorage) and travel inside saved session files, so opening a session on
 * another machine brings its presets along (`mergePresets`).
 */

export interface SynthPreset {
    name: string;
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
    bendRange?: number;
}

export interface SamplerPreset {
    name: string;
    pitch: number;
    speed: number;
    isReversed: boolean;
    gate: boolean;
}

export interface EffectUserPreset {
    name: string;
    params: Record<string, number>;
}

/** Every user preset, by device. */
export interface UserPresets {
    effects: Partial<Record<EffectKey, EffectUserPreset[]>>;
    synth: SynthPreset[];
    sampler: SamplerPreset[];
}

export const SYNTH_FACTORY: readonly SynthPreset[] = [
    { name: 'Soft keys', oscillatorType: 'triangle', envelope: { attack: 0.01, decay: 0.4, sustain: 0.3, release: 0.6 } },
    { name: 'Pluck', oscillatorType: 'sawtooth', envelope: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.15 } },
    { name: 'Bass', oscillatorType: 'square', envelope: { attack: 0.005, decay: 0.25, sustain: 0.6, release: 0.08 } },
    { name: 'Pad', oscillatorType: 'sawtooth', envelope: { attack: 0.8, decay: 1.2, sustain: 0.7, release: 2 } },
    { name: 'Lead', oscillatorType: 'square', envelope: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.25 } },
    { name: 'Sub sine', oscillatorType: 'sine', envelope: { attack: 0.005, decay: 0.3, sustain: 0.9, release: 0.2 } },
];

export const SAMPLER_FACTORY: readonly SamplerPreset[] = [
    { name: 'Original', pitch: 0, speed: 1, isReversed: false, gate: false },
    { name: 'Octave down', pitch: -12, speed: 1, isReversed: false, gate: false },
    { name: 'Chipmunk', pitch: 12, speed: 1, isReversed: false, gate: false },
    { name: 'Reversed', pitch: 0, speed: 1, isReversed: true, gate: false },
    { name: 'Half speed', pitch: 0, speed: 0.5, isReversed: false, gate: false },
    { name: 'Gated', pitch: 0, speed: 1, isReversed: false, gate: true },
];

const STORAGE_KEY = 'juicyloops:presets';

const empty = (): UserPresets => ({ effects: {}, synth: [], sampler: [] });

const parse = (raw: unknown): UserPresets => {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<UserPresets>;
    return {
        effects: value.effects && typeof value.effects === 'object' ? value.effects : {},
        synth: Array.isArray(value.synth) ? value.synth : [],
        sampler: Array.isArray(value.sampler) ? value.sampler : [],
    };
};

const load = (): UserPresets => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? parse(JSON.parse(raw)) : empty();
    } catch {
        return empty();
    }
};

const user = ref<UserPresets>(load());

watch(
    user,
    (value) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        } catch {
            /* the presets simply do not persist */
        }
    },
    { deep: true },
);

/** Replaces a preset of the same name, else adds it. */
const upsert = <T extends { name: string }>(list: T[], preset: T): T[] => [...list.filter((item) => item.name !== preset.name), preset];

const saveEffectPreset = (effect: EffectKey, name: string, params: Record<string, number>): void => {
    user.value = { ...user.value, effects: { ...user.value.effects, [effect]: upsert(user.value.effects[effect] ?? [], { name, params: { ...params } }) } };
};

const removeEffectPreset = (effect: EffectKey, name: string): void => {
    user.value = { ...user.value, effects: { ...user.value.effects, [effect]: (user.value.effects[effect] ?? []).filter((preset) => preset.name !== name) } };
};

const saveSynthPreset = (preset: SynthPreset): void => {
    user.value = { ...user.value, synth: upsert(user.value.synth, { ...preset, envelope: { ...preset.envelope } }) };
};

const removeSynthPreset = (name: string): void => {
    user.value = { ...user.value, synth: user.value.synth.filter((preset) => preset.name !== name) };
};

const saveSamplerPreset = (preset: SamplerPreset): void => {
    user.value = { ...user.value, sampler: upsert(user.value.sampler, { ...preset }) };
};

const removeSamplerPreset = (name: string): void => {
    user.value = { ...user.value, sampler: user.value.sampler.filter((preset) => preset.name !== name) };
};

/** A copy of every user preset, for a session file. */
const exportPresets = (): UserPresets => JSON.parse(JSON.stringify(user.value)) as UserPresets;

/** Adds the presets of an opened session file; a preset of the same name here is kept. */
const mergePresets = (incoming: unknown): void => {
    const other = parse(incoming);
    const keep = <T extends { name: string }>(mine: T[], theirs: T[]): T[] => [...mine, ...theirs.filter((preset) => !mine.some((item) => item.name === preset.name))];
    const effects = { ...user.value.effects };
    for (const [effect, presets] of Object.entries(other.effects) as [EffectKey, EffectUserPreset[]][]) {
        effects[effect] = keep(effects[effect] ?? [], Array.isArray(presets) ? presets : []);
    }
    user.value = { effects, synth: keep(user.value.synth, other.synth), sampler: keep(user.value.sampler, other.sampler) };
};

export const usePresets = () => ({
    user,
    factoryEffects: EFFECT_PRESETS,
    saveEffectPreset,
    removeEffectPreset,
    saveSynthPreset,
    removeSynthPreset,
    saveSamplerPreset,
    removeSamplerPreset,
    exportPresets,
    mergePresets,
});
