import { describe, expect, it, vi } from 'vitest';
import { setPoint } from '../automation';
import { EFFECT_KEYS, initialParams } from '../effects/definitions';
import { DEFAULT_EFFECT_ORDER, Effects, type EffectsSnapshot } from '../effects/effects';
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
    return { ...tone, Compressor: FakeDynamics, Limiter: FakeDynamics };
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
    /** A rack as it was stored before the dynamics went lazy: compressing at 12:1, flat EQ, a limiter without a switch. */
    const oldSnapshot = (): EffectsSnapshot => {
        const params = Object.fromEntries(EFFECT_KEYS.map((effect) => [effect, initialParams(effect)])) as EffectsSnapshot['params'];
        params.compressor = { ...params.compressor, ratio: 12 };
        params.limiter = { threshold: -1 };
        return { order: [...DEFAULT_EFFECT_ORDER], params };
    };

    it('starts a track rack with no dynamics nodes and the master with its limiter', () => {
        const track = new Effects({ role: 'track' });
        expect((['compressor', 'equalizer', 'limiter'] as const).some((effect) => track.isActive(effect))).toBe(false);

        const master = new Effects({ role: 'master' });
        expect(master.isActive('limiter')).toBe(true);
        expect(master.isActive('compressor')).toBe(false);
        expect(master.getParam('limiter', 'on')).toBe(1);
    });

    it('restores an old snapshot with the limiter on and the compressor as stored', () => {
        const rack = new Effects({ role: 'track' });
        rack.restore(oldSnapshot());

        expect(rack.isActive('limiter')).toBe(true);
        expect(rack.getParam('limiter', 'on')).toBe(1);
        expect(rack.isActive('compressor')).toBe(true);
        expect(rack.getParam('compressor', 'ratio')).toBe(12);
        expect(rack.isActive('equalizer')).toBe(false);
        expect(rack.capture().params.limiter).toEqual({ threshold: -1, on: 1 });
    });

    it('takes the switch of a new snapshot as it is and copies it with the rack', () => {
        const master = new Effects({ role: 'master' });
        const snapshot = master.capture();
        snapshot.params.limiter.on = 0;
        master.restore(snapshot);
        expect(master.isActive('limiter')).toBe(false);

        const source = new Effects({ role: 'track' });
        source.restore(oldSnapshot());
        const copy = new Effects({ role: 'track' });
        copy.copyFrom(source);
        expect(copy.isActive('limiter')).toBe(true);
        expect(copy.capture()).toEqual(source.capture());
    });

    it('builds a neutral compressor when automation raises its ratio and keeps it when the ratio comes back', () => {
        const rack = new Effects({ role: 'bus' });
        rack.setParameter('fx.compressor.ratio', 1, 1);
        expect(rack.isActive('compressor')).toBe(false);

        rack.setParameter('fx.compressor.ratio', 4, 1);
        expect(rack.isActive('compressor')).toBe(true);
        // Automation plays the value, the knob keeps the stored one.
        expect(rack.getParam('compressor', 'ratio')).toBe(1);

        rack.setParameter('fx.compressor.ratio', 1, 2);
        expect(rack.isActive('compressor')).toBe(true);

        // Setting it for real removes the node again.
        rack.setParam('compressor', 'ratio', 1);
        expect(rack.isActive('compressor')).toBe(false);
    });

    it('resets the limiter to what the rack started with', () => {
        const master = new Effects({ role: 'master' });
        master.setParam('limiter', 'on', 0);
        master.reset('limiter');
        expect(master.isActive('limiter')).toBe(true);

        const track = new Effects({ role: 'track' });
        track.setParam('limiter', 'on', 1);
        expect(track.isActive('limiter')).toBe(true);
        track.reset('limiter');
        expect(track.isActive('limiter')).toBe(false);
    });
});
