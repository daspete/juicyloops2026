import { describe, expect, it, vi } from 'vitest';

/* jsdom has no Web Audio: the master's limiter and an added compressor are stand-ins that take values. */
vi.mock('tone', async (importOriginal) => {
    const tone = await importOriginal<typeof import('tone')>();
    class FakeDynamics {
        readonly context = { currentTime: 0 };
        readonly threshold = { value: 0 };
        readonly ratio = { value: 0 };
        readonly attack = { value: 0 };
        readonly release = { value: 0 };
        disconnect() {}
        dispose() {}
    }
    return { ...tone, Compressor: FakeDynamics, Limiter: FakeDynamics };
});
import { addedParams, EFFECT_DEFINITIONS, EFFECT_INFO, EFFECT_KEYS, EFFECT_PRESETS, initialParams, isEffectNeeded, type EffectDefinition, type EffectKey } from '../effects/definitions';
import { Effects, upgradeEffectParams } from '../effects/effects';

describe('effect definitions', () => {
    it('describes every effect with at least one sane parameter', () => {
        for (const key of EFFECT_KEYS) {
            const definition = EFFECT_DEFINITIONS[key];

            expect(definition.label.length).toBeGreaterThan(0);
            expect(definition.params.length).toBeGreaterThan(0);
            expect(definition.params.length).toBeLessThanOrEqual(4);

            for (const param of definition.params) {
                expect(param.min).toBeLessThan(param.max);
                expect(param.step).toBeGreaterThan(0);
                expect(param.initial).toBeGreaterThanOrEqual(param.min);
                expect(param.initial).toBeLessThanOrEqual(param.max);
            }
        }
    });

    it('starts every mixable effect fully dry', () => {
        const wetParams = EFFECT_KEYS.flatMap((key) => EFFECT_DEFINITIONS[key].params.filter((param) => param.key === 'wet'));

        expect(wetParams.length).toBeGreaterThan(0);
        expect(wetParams.every((param) => param.initial === 0)).toBe(true);
    });

    it('does not repeat a parameter within one effect', () => {
        for (const key of EFFECT_KEYS) {
            const keys = EFFECT_DEFINITIONS[key].params.map((param) => param.key);
            expect(new Set(keys).size).toBe(keys.length);
        }
    });

    it('gives every effect without a mix control a neutral predicate that holds for a fresh track', () => {
        const definitions: [EffectKey, EffectDefinition][] = EFFECT_KEYS.map((key) => [key, EFFECT_DEFINITIONS[key]]);
        const mixable = definitions.filter(([, definition]) => definition.params.some((param) => param.key === 'wet'));
        const dynamics = definitions.filter(([, definition]) => !mixable.some(([, other]) => other === definition));

        expect(dynamics.map(([key]) => key).sort()).toEqual(['compressor', 'equalizer', 'limiter']);
        expect(mixable.every(([, definition]) => definition.isNeutral === undefined)).toBe(true);
        expect(dynamics.every(([key, definition]) => definition.isNeutral?.(initialParams(key)) === true)).toBe(true);
    });

    it('needs a compressor above 1:1, an EQ off flat and a limiter switched on', () => {
        const compressor = initialParams('compressor');
        expect(compressor.ratio).toBe(1);
        expect(isEffectNeeded('compressor', compressor)).toBe(false);
        expect(isEffectNeeded('compressor', { ...compressor, threshold: -60 })).toBe(false);
        expect(isEffectNeeded('compressor', { ...compressor, ratio: 1.1 })).toBe(true);

        const flat = initialParams('equalizer');
        expect(isEffectNeeded('equalizer', flat)).toBe(false);
        expect(isEffectNeeded('equalizer', { ...flat, mid: 0.05, high: -0.04 })).toBe(false);
        expect(isEffectNeeded('equalizer', { ...flat, low: -0.1 })).toBe(true);
        expect(isEffectNeeded('equalizer', { ...flat, high: 3 })).toBe(true);

        expect(isEffectNeeded('limiter', { threshold: -1, on: 0 })).toBe(false);
        expect(isEffectNeeded('limiter', { threshold: -1, on: 1 })).toBe(true);
        // A limiter from before the switch existed was always on.
        expect(isEffectNeeded('limiter', { threshold: -1 })).toBe(true);
    });

    it('still needs a mixable effect once it is not fully dry', () => {
        expect(isEffectNeeded('reverb', initialParams('reverb'))).toBe(false);
        expect(isEffectNeeded('reverb', { ...initialParams('reverb'), wet: 0.2 })).toBe(true);
    });

    it('starts the limiter on for the master only', () => {
        expect(initialParams('limiter', 'master').on).toBe(1);
        expect(initialParams('limiter', 'bus').on).toBe(0);
        expect(initialParams('limiter', 'track').on).toBe(0);
        expect(initialParams('limiter').on).toBe(0);
        // Nothing else depends on the role.
        expect(initialParams('compressor', 'master')).toEqual(initialParams('compressor', 'track'));
        expect(initialParams('equalizer', 'master')).toEqual(initialParams('equalizer', 'bus'));
    });

    it('keeps the limiter switch out of automation', () => {
        const rack = new Effects({ role: 'master' });
        rack.add('compressor');
        const keys = rack.parameters.map((param) => param.key);
        expect(keys).not.toContain('fx.limiter.on');
        expect(keys).toContain('fx.limiter.threshold');
        expect(keys).toContain('fx.compressor.ratio');
    });

    it('describes every effect for the rack: a macro face of known params, added values that are heard', () => {
        for (const key of EFFECT_KEYS) {
            const info = EFFECT_INFO[key];
            const params = EFFECT_DEFINITIONS[key].params.map((param) => param.key as string);
            expect(info.macros.length).toBeGreaterThan(0);
            expect(info.macros.every((macro) => params.includes(macro.key))).toBe(true);
            // A flat EQ is the one effect that starts silent when added: its bands start at 0 dB.
            expect(isEffectNeeded(key, addedParams(key))).toBe(key !== 'equalizer');
            for (const preset of EFFECT_PRESETS[key] ?? []) {
                expect(Object.keys(preset.params).every((param) => params.includes(param))).toBe(true);
            }
        }
    });

    it('switches the limiter of an old snapshot on and keeps everything else as stored', () => {
        const old = { compressor: { threshold: -24, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { threshold: -3 } };
        const upgraded = upgradeEffectParams(old);
        expect(upgraded.limiter).toEqual({ threshold: -3, on: 1 });
        expect(upgraded.compressor).toEqual(old.compressor);
        expect(old.limiter).toEqual({ threshold: -3 });

        // A snapshot that has the switch keeps it, either way.
        expect(upgradeEffectParams({ limiter: { threshold: -1, on: 0 } }).limiter).toEqual({ threshold: -1, on: 0 });
        expect(upgradeEffectParams({ limiter: { threshold: -1, on: 1 } }).limiter).toEqual({ threshold: -1, on: 1 });
    });
});
