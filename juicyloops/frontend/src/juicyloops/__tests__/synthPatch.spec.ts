import { describe, expect, it } from 'vitest';
import { AUTOMATABLE_PATCH_PARAMS, defaultPatch, normalizePatch, PATCH_PARAMS, patchParam, type PatchModel } from '../synths/params';
import { PATCH_FACTORY } from '../synths/presets';

const MODELS: PatchModel[] = ['analog', 'wavetable', 'fm'];
/** Slots in the engine's patch (`PARAM_COUNT` in params.rs). */
const PARAM_COUNT = 140;

describe('patch parameters', () => {
    it.each(MODELS)('%s: unique keys and ids inside the engine patch, defaults in range', (model) => {
        const params = PATCH_PARAMS[model];
        expect(new Set(params.map((param) => param.key)).size).toBe(params.length);
        expect(new Set(params.map((param) => param.id)).size).toBe(params.length);
        for (const param of params) {
            expect(param.key.startsWith('patch.')).toBe(true);
            expect(param.id).toBeGreaterThanOrEqual(0);
            expect(param.id).toBeLessThan(PARAM_COUNT);
            expect(param.default).toBeGreaterThanOrEqual(param.min);
            expect(param.default).toBeLessThanOrEqual(param.max);
        }
        for (const param of params.filter((p) => p.options)) {
            expect(param.max).toBe(param.options!.length - 1);
        }
        for (const param of params.filter((p) => p.curve === 'log')) {
            expect(param.min).toBeGreaterThan(0);
        }
        expect(AUTOMATABLE_PATCH_PARAMS[model].every((param) => !param.options)).toBe(true);
    });

    it('keeps the host-owned ids (bend, tempo) out of the tables', () => {
        for (const model of MODELS) {
            expect(PATCH_PARAMS[model].some((param) => param.id === 3 || param.id === 5)).toBe(false);
        }
    });

    it('normalizes stored patches: defaults for gaps, clamped values, unknown keys dropped, prefix optional', () => {
        const patch = normalizePatch('analog', { 'filter.cutoff': 99999, 'patch.osc1.wave': 2.6, nonsense: 3, 'osc2.level': 'loud' });
        expect(patch['patch.filter.cutoff']).toBe(20000);
        expect(patch['patch.osc1.wave']).toBe(3);
        expect(patch['patch.osc2.level']).toBe(0);
        expect(patch).not.toHaveProperty('nonsense');
        expect(Object.keys(patch)).toEqual(Object.keys(defaultPatch('analog')));
    });

    it.each(MODELS)('%s: every factory preset uses real parameters with values in range', (model) => {
        for (const preset of PATCH_FACTORY[model]) {
            for (const [key, value] of Object.entries(preset.patch)) {
                const param = patchParam(model, `patch.${key}`);
                expect(param, `${preset.name}: ${key}`).toBeDefined();
                expect(value, `${preset.name}: ${key}`).toBeGreaterThanOrEqual(param!.min);
                expect(value, `${preset.name}: ${key}`).toBeLessThanOrEqual(param!.max);
            }
        }
    });
});
