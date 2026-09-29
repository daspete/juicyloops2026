import { describe, expect, it, vi } from 'vitest';
import { setPoint } from '../automation';
import { EFFECT_KEYS, initialParams } from '../effects/definitions';
import { DEFAULT_EFFECT_ORDER, Effects, type LegacyEffectsSnapshot } from '../effects/effects';
import { Song } from '../song';

/*
 * jsdom has no Web Audio, so the dynamics nodes are stand-ins with the same parameters. The rack only needs them
 * to exist, take values and be disposed; what they sound like is checked in the browser.
 */
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
    class FakeWet {
        readonly context = { currentTime: 0 };
        readonly wet = { value: 0 };
        readonly delayTime = { value: 0 };
        decay = 1;
        preDelay = 0;
        readonly ready = Promise.resolve();
        toSeconds(value: number) {
            return value;
        }
        disconnect() {}
        dispose() {}
    }
    return { ...tone, Compressor: FakeDynamics, Limiter: FakeDynamics, Reverb: FakeWet, FeedbackDelay: Object.assign(FakeWet, { getDefaults: tone.FeedbackDelay.getDefaults }) };
});

/** The tracks and buses own audio nodes and are checked in the browser; the song's part of a snapshot is pure data. */
describe('song history', () => {
    it('captures a copy and takes it back, keeping the objects of what still exists', () => {
        const song = new Song();
        const lane = song.lanes[0]!;
        const clip = song.addClip(lane.id, 'a', 0, 32)!;
        const auto = song.addAutomation({ kind: 'master' }, 'volume');
        setPoint(auto, 16, 0.5);

        const before = song.capture();
        expect(before.lanes[0]!.clips[0]).not.toBe(clip);

        song.moveClip(clip.id, 64);
        song.addLane();
        song.removeAutomation(auto.id);
        clip.length = 16;

        song.restore(before);
        expect(song.lanes).toHaveLength(1);
        expect(song.lanes[0]).toBe(lane);
        expect(lane.clips).toHaveLength(1);
        expect(lane.clips[0]).toMatchObject({ id: clip.id, start: 0, length: 32 });
        expect(song.automation).toHaveLength(1);
        expect(song.automation[0]).toMatchObject({ id: auto.id, param: 'volume' });
        expect(song.automation[0]!.points).toEqual([{ step: 16, value: 0.5 }]);

        // The snapshot is not tied to the song: changing the song afterwards leaves it alone.
        lane.clips[0]!.start = 48;
        expect(before.lanes[0]!.clips[0]!.start).toBe(0);
    });

    it('brings back lanes that were deleted with their old ids', () => {
        const song = new Song(2);
        const [first, second] = song.lanes;
        song.addClip(second!.id, 'b', 16, 16);
        const before = song.capture();

        song.removeLane(second!.id);
        expect(song.lanes).toEqual([first]);

        song.restore(before);
        expect(song.lanes.map((lane) => lane.id)).toEqual([first!.id, second!.id]);
        expect(song.lanes[1]!.clips[0]).toMatchObject({ containerId: 'b', start: 16 });
    });
});

describe('effect rack snapshots', () => {
    /** A rack as it was stored before slots: compressing at 12:1, flat EQ, a limiter without a switch, a dry reverb. */
    const oldSnapshot = (): LegacyEffectsSnapshot => {
        const params = Object.fromEntries(EFFECT_KEYS.map((effect) => [effect, initialParams(effect)])) as LegacyEffectsSnapshot['params'];
        params.compressor = { ...params.compressor, ratio: 12 };
        params.limiter = { threshold: -1 };
        params.reverb = { ...params.reverb, decay: 3 };
        return { order: [...DEFAULT_EFFECT_ORDER], params };
    };

    it('starts a track rack empty and the master with its limiter', () => {
        const track = new Effects({ role: 'track' });
        expect(track.chain).toEqual([]);

        const master = new Effects({ role: 'master' });
        expect(master.chain.map((slot) => slot.effect)).toEqual(['limiter']);
        expect(master.isActive('limiter')).toBe(true);
        expect(master.getParam('limiter', 'on')).toBe(1);
    });

    it('turns an old snapshot into slots of the effects that did something, ids being the effect keys', () => {
        const rack = new Effects({ role: 'track' });
        rack.restore(oldSnapshot());

        expect(rack.chain.map((slot) => slot.id)).toEqual(['compressor', 'limiter']);
        expect(rack.getParam('limiter', 'on')).toBe(1);
        expect(rack.getParam('compressor', 'ratio')).toBe(12);
        expect(rack.isActive('compressor')).toBe(true);
        // Old automation addresses still reach them.
        expect(rack.getParameter('fx.compressor.ratio')).toBe(12);
        expect(rack.parameter('fx.limiter.threshold')).toBeDefined();
        expect(rack.parameter('fx.limiter.on')).toBeUndefined();
    });

    it('brings back an idle effect of an old snapshot that automation still drives, in its old place', () => {
        const rack = new Effects({ role: 'track' });
        rack.restore(oldSnapshot());
        rack.ensureLegacySlots(['fx.reverb.wet', 'volume', 'fx.nothing.wet']);

        expect(rack.chain.map((slot) => slot.id)).toEqual(['reverb', 'compressor', 'limiter']);
        expect(rack.getParam('reverb', 'decay')).toBe(3);
        expect(rack.isActive('reverb')).toBe(false);
    });

    it('adds, duplicates, bypasses, moves and removes slots, numbering a second copy of an effect', () => {
        const rack = new Effects({ role: 'track' });
        const eq = rack.add('equalizer');
        const reverb = rack.add('reverb');
        expect(rack.isActive(reverb)).toBe(true);
        expect(rack.isActive(eq)).toBe(false); // a flat EQ does nothing yet

        const copy = rack.duplicate(reverb)!;
        expect(copy).toBe('reverb2');
        expect(rack.slotLabel(copy)).toBe('Reverb 2');
        expect(rack.parameter('fx.reverb2.wet')?.group).toBe('Reverb 2');

        rack.setBypassed(reverb, true);
        expect(rack.isActive(reverb)).toBe(false);
        expect(rack.isNeeded(reverb)).toBe(false);
        rack.setBypassed(reverb, false);
        expect(rack.isActive(reverb)).toBe(true);

        rack.moveTo(copy, 0);
        expect(rack.chain.map((slot) => slot.id)).toEqual(['reverb2', 'equalizer', 'reverb']);

        rack.remove(eq);
        expect(rack.chain.map((slot) => slot.id)).toEqual(['reverb2', 'reverb']);
        expect(rack.add('equalizer')).toBe('equalizer');
    });

    it('captures, restores and copies slots with their ids', () => {
        const source = new Effects({ role: 'track' });
        source.restore(oldSnapshot());
        source.add('delay');
        source.setBypassed('delay', true);

        const copy = new Effects({ role: 'track' });
        copy.copyFrom(source);
        expect(copy.capture()).toEqual(source.capture());
        expect(copy.isActive('delay')).toBe(false);

        const master = new Effects({ role: 'master' });
        const snapshot = master.capture();
        snapshot.slots[0]!.params.on = 0;
        master.restore(snapshot);
        expect(master.isActive('limiter')).toBe(false);
    });

    it('builds a neutral compressor when automation raises its ratio and keeps it when the ratio comes back', () => {
        const rack = new Effects({ role: 'bus' });
        const id = rack.add('compressor', 0, { ratio: 1 });
        rack.setParameter(`fx.${id}.ratio`, 1, 1);
        expect(rack.isActive(id)).toBe(false);

        rack.setParameter(`fx.${id}.ratio`, 4, 1);
        expect(rack.isActive(id)).toBe(true);
        // Automation plays the value, the knob keeps the stored one.
        expect(rack.getParam(id, 'ratio')).toBe(1);

        rack.setParameter(`fx.${id}.ratio`, 1, 2);
        expect(rack.isActive(id)).toBe(true);

        // Setting it for real removes the node again.
        rack.setParam(id, 'ratio', 1);
        expect(rack.isActive(id)).toBe(false);
    });

    it('resets a slot to the values it was added with', () => {
        const master = new Effects({ role: 'master' });
        master.setParam('limiter', 'on', 0);
        master.reset('limiter');
        expect(master.isActive('limiter')).toBe(true);

        const track = new Effects({ role: 'track' });
        const reverb = track.add('reverb');
        track.setParam(reverb, 'wet', 0);
        expect(track.isActive(reverb)).toBe(false);
        track.reset(reverb);
        expect(track.getParam(reverb, 'wet')).toBe(0.3);
        expect(track.isActive(reverb)).toBe(true);
    });
});

