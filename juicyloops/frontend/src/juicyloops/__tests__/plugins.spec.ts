import { describe, expect, it, vi } from 'vitest';
import { Effects, slotsFromLegacy, type EffectsSnapshot } from '../effects/effects';
import { CURATED_PLUGINS, fromCommunity, normalizePluginUrl } from '../plugins/catalog';

/* jsdom has no Web Audio: a plugin slot's node is a stand-in that reports a state and counts how often it was made. */
const made: string[] = [];
vi.mock('../plugins/WamEffect', () => ({
    WamEffect: class {
        readonly ready = Promise.resolve();
        readonly url: string;
        constructor({ plugin }: { plugin: { url: string } }) {
            this.url = plugin.url;
            made.push(plugin.url);
        }
        getState() {
            return Promise.resolve({ drive: 0.7 });
        }
        disconnect() {}
        dispose() {}
    },
}));

const MUFF = { url: 'https://plugins.example/muff/index.js', name: 'Big Muff', vendor: 'Wimmics', state: null };

describe('plugin slots', () => {
    it('adds a plugin that is always heard, named after it, and stored with its address', () => {
        const rack = new Effects();
        const id = rack.addPlugin(MUFF);
        expect(rack.effectOf(id)).toBe('plugin');
        expect(rack.slotLabel(id)).toBe('Big Muff');
        expect(rack.isNeeded(id)).toBe(true);
        expect(rack.isActive(id)).toBe(true);
        expect(rack.capture().slots[0]).toMatchObject({ id, effect: 'plugin', plugin: { url: MUFF.url, name: 'Big Muff', vendor: 'Wimmics', state: null } });
        expect(rack.parameters).toEqual([]);
    });

    it('numbers a second copy and copies the plugin with its state', async () => {
        const rack = new Effects();
        const id = rack.addPlugin(MUFF);
        await rack.refreshPluginStates();
        const copy = rack.duplicate(id)!;
        expect(rack.slotLabel(id)).toBe('Big Muff 1');
        expect(rack.slotLabel(copy)).toBe('Big Muff 2');
        expect(rack.pluginOf(copy)).toMatchObject({ url: MUFF.url, state: { drive: 0.7 } });
        const other = new Effects();
        other.copySlot(rack, copy);
        expect(other.pluginOf(other.chain[0]!.id)?.state).toEqual({ drive: 0.7 });
    });

    it('reads the plugin state into the next capture', async () => {
        const rack = new Effects();
        rack.addPlugin(MUFF);
        expect(rack.capture().slots[0]!.plugin!.state).toBeNull();
        await rack.refreshPluginStates();
        expect(rack.capture().slots[0]!.plugin!.state).toEqual({ drive: 0.7 });
    });

    it('keeps a restored plugin that did not change, and loads it again when its state did', async () => {
        const rack = new Effects();
        rack.addPlugin(MUFF);
        await rack.refreshPluginStates();
        const same = rack.capture();
        made.length = 0;
        rack.restore(same);
        expect(made).toEqual([]);
        const changed: EffectsSnapshot = { slots: same.slots.map((slot) => ({ ...slot, plugin: { ...slot.plugin!, state: { drive: 0.1 } } })) };
        rack.restore(changed);
        expect(made).toEqual([MUFF.url]);
        expect(rack.capture().slots[0]!.plugin!.state).toEqual({ drive: 0.1 });
    });

    it('drops stored plugin slots without a plugin, and old racks never get one', () => {
        const rack = new Effects();
        rack.restore({ slots: [{ id: 'plugin', effect: 'plugin', bypassed: false, params: {} }] });
        expect(rack.size).toBe(0);
        expect(slotsFromLegacy({ order: [], params: {} } as never).map((slot) => slot.effect)).not.toContain('plugin');
    });
});

describe('plugin catalogue', () => {
    it('keeps instruments and audio effects of the community list, with absolute addresses', () => {
        expect(fromCommunity({ identifier: 'a', name: 'Synth-101', vendor: 'SP', category: ['Instrument', 'Synthesizer'], path: 'burns-audio/synth101/index.js', thumbnail: 'burns-audio/synth101/shot.png' })).toEqual({
            url: 'https://www.webaudiomodules.com/community/plugins/burns-audio/synth101/index.js',
            name: 'Synth-101',
            vendor: 'SP',
            description: '',
            kind: 'instrument',
            category: 'Synthesizer',
            thumbnail: 'https://www.webaudiomodules.com/community/plugins/burns-audio/synth101/shot.png',
            source: 'community',
            liveOnly: true,
        });
        expect(fromCommunity({ name: 'Grey Hole', category: ['Effect', 'Reverb'], path: 'wimmics/greyhole/index.js' })?.kind).toBe('effect');
        expect(fromCommunity({ name: 'Piano Roll', category: ['MIDI', 'Sequencer'], path: 'x/index.js' })).toBeNull();
        expect(fromCommunity({ name: 'Video', category: ['Video', 'Generator'], path: 'x/index.js' })).toBeNull();
        expect(fromCommunity({ identifier: 'com.sequencerParty.audioInput', name: 'Audio Input', category: ['Effect', 'Utility'], path: 'x/index.js' })).toBeNull();
    });

    it('lists the curated plugins once each, as https modules, instruments and effects', () => {
        const urls = CURATED_PLUGINS.map((entry) => entry.url);
        expect(new Set(urls).size).toBe(urls.length);
        expect(urls.every((url) => url.startsWith('https://') && url.endsWith('/index.js'))).toBe(true);
        expect(CURATED_PLUGINS.every((entry) => entry.source === 'curated' && entry.name && entry.description)).toBe(true);
        expect(new Set(CURATED_PLUGINS.map((entry) => entry.kind))).toEqual(new Set(['instrument', 'effect']));
    });

    it('marks community plugins known to be silent in exports', () => {
        expect(fromCommunity({ name: 'Synth-101', category: ['Instrument', 'Synthesizer'], path: 'burns-audio/synth101/index.js' })?.liveOnly).toBe(true);
        expect(fromCommunity({ name: 'Modal', category: ['Instrument', 'Synthesizer'], path: 'burns-audio/modal/index.js' })?.liveOnly).toBeUndefined();
    });

    it('takes a typed address to the plugin module', () => {
        expect(normalizePluginUrl('https://example.com/my-plugin/')).toBe('https://example.com/my-plugin/index.js');
        expect(normalizePluginUrl(' https://example.com/p/dist/index.js ')).toBe('https://example.com/p/dist/index.js');
        expect(normalizePluginUrl('https://example.com/p/main.mjs')).toBe('https://example.com/p/main.mjs');
        expect(normalizePluginUrl('javascript:alert(1)')).toBeNull();
        expect(normalizePluginUrl('not an address')).toBeNull();
    });
});
