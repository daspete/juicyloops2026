import { describe, expect, it } from 'vitest';
import type { AutomationParam, AutomationTarget } from '../automation';
import { cloneMappings, controllerValue, learnMapping, listensTo, mappingOf, mappingsFor, paramKey, removeMapping, type MidiMapping } from '../midi/mappings';

const track: AutomationTarget = { kind: 'track', containerId: 'c1', trackId: 't1' };
const master: AutomationTarget = { kind: 'master' };

describe('MIDI mappings', () => {
    it('learns a mapping, replacing the same parameter and the same controller', () => {
        let list: MidiMapping[] = [];
        list = learnMapping(list, { cc: 74, channel: 0, target: track, param: 'envelope.attack' });
        list = learnMapping(list, { cc: 71, channel: 0, target: master, param: 'volume' });
        expect(list).toHaveLength(2);
        // The attack gets another controller: the old mapping goes.
        list = learnMapping(list, { cc: 10, channel: 0, target: { ...track }, param: 'envelope.attack' });
        expect(list.map((mapping) => mapping.cc)).toEqual([71, 10]);
        // CC71 now turns the release: the master volume loses it.
        list = learnMapping(list, { cc: 71, channel: 'all', target: track, param: 'envelope.release' });
        expect(list.map((mapping) => `${mapping.cc}:${mapping.param}`)).toEqual(['10:envelope.attack', '71:envelope.release']);
    });

    it('keeps one controller on different channels apart', () => {
        let list = learnMapping([], { cc: 1, channel: 0, target: track, param: 'volume' });
        list = learnMapping(list, { cc: 1, channel: 1, target: track, param: 'pan' });
        expect(list).toHaveLength(2);
        expect(mappingsFor(list, 1, 1).map((mapping) => mapping.param)).toEqual(['pan']);
        expect(mappingsFor(list, 1, 2)).toEqual([]);
    });

    it('listens on every channel when told so', () => {
        const mapping: MidiMapping = { cc: 7, channel: 'all', target: master, param: 'volume' };
        expect(listensTo(mapping, 7, 0)).toBe(true);
        expect(listensTo(mapping, 7, 15)).toBe(true);
        expect(listensTo(mapping, 8, 0)).toBe(false);
    });

    it('finds and removes mappings', () => {
        const list = learnMapping(learnMapping([], { cc: 1, channel: 0, target: track, param: 'volume' }), { cc: 2, channel: 0, target: master, param: 'pan' });
        expect(mappingOf(list, { kind: 'master' }, 'pan')?.cc).toBe(2);
        expect(mappingOf(list, track, 'pan')).toBeUndefined();
        expect(removeMapping(list, 0).map((mapping) => mapping.cc)).toEqual([2]);
        expect(list).toHaveLength(2);
    });

    it("turns a controller position into the parameter's value, curve and step included", () => {
        const linear: AutomationParam = { key: 'pan', label: 'Pan', group: 'Mix', min: -1, max: 1, step: 0.01 };
        expect(controllerValue(linear, 0)).toBe(-1);
        expect(controllerValue(linear, 127)).toBe(1);
        expect(controllerValue(linear, 63.5)).toBe(0);
        const log: AutomationParam = { key: 'a', label: 'A', group: 'Synth', min: 0.001, max: 2, step: 0.001, curve: 'log' };
        expect(controllerValue(log, 0)).toBe(0.001);
        expect(controllerValue(log, 127)).toBe(2);
        expect(controllerValue(log, 64)).toBeLessThan(0.1);
        expect(controllerValue(linear, 500)).toBe(1);
    });

    it('copies for history and drops what is not a mapping', () => {
        const list = [{ cc: 5, channel: 3, target: track, param: 'volume' }, { cc: 300, channel: 0, target: track, param: 'pan' }] as MidiMapping[];
        const copy = cloneMappings(list);
        expect(copy).toEqual([{ cc: 5, channel: 3, target: track, param: 'volume' }]);
        expect(copy[0]!.target).not.toBe(track);
        expect(cloneMappings(undefined)).toEqual([]);
    });

    it('keys parameters by owner', () => {
        expect(paramKey(track, 'volume')).not.toBe(paramKey({ kind: 'container', containerId: 'c1' }, 'volume'));
        expect(paramKey(master, 'volume')).toBe('master|volume');
    });
});
