import { describe, expect, it } from 'vitest';
import { EFFECT_DEFINITIONS, EFFECT_KEYS } from '../effects/definitions';

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
});
