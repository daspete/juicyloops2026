import { describe, expect, it } from 'vitest';
import { dynamicsInPath, loopLength, planRender, RenderError, renderDuration, secondsPerStep } from '../render';
import type { SessionState } from '../sequencer';
import { Song } from '../song';
import type { TrackState } from '../tracks/BaseTrack';
import { DEFAULT_EFFECT_ORDER, type LegacyEffectsSnapshot } from '../effects/effects';
import { EFFECT_KEYS, initialParams, type EffectRackRole } from '../effects/definitions';

/* The tracks and buses own audio nodes, so the render itself is checked in the browser; the plan is pure data. */

const effects = (role: EffectRackRole = 'track'): LegacyEffectsSnapshot => ({
    order: [...DEFAULT_EFFECT_ORDER],
    params: Object.fromEntries(EFFECT_KEYS.map((effect) => [effect, initialParams(effect, role)])) as LegacyEffectsSnapshot['params'],
});

const track = (id: string, type: TrackState['type'], length: number, isMuted = false): TrackState => ({
    id,
    type,
    length,
    // A note that rings three times past the pattern's end: the loop still repeats after `length` steps.
    notes: [{ id: `${id}-n`, note: 'C5', start: length - 1, length: length * 3, velocity: 1 }],
    volume: 0,
    pan: 0,
    isMuted,
    effects: effects(),
    automation: [],
});

const session = (): SessionState => {
    const song = new Song();
    return {
        containers: [
            { id: 'a', name: 'A', bus: { volume: 0, pan: 0, effects: effects() }, tracks: [track('t1', 'synth', 16), track('t2', 'microphone', 24, true)] },
            { id: 'b', name: 'B', bus: { volume: 0, pan: 0, effects: effects() }, tracks: [track('t3', 'sampler', 32)] },
        ],
        currentContainerId: 'a',
        song: song.capture(),
        master: { volume: 0, pan: 0, effects: effects('master') },
    };
};

describe('loopLength', () => {
    it('is the least common multiple of the pattern lengths', () => {
        expect(loopLength([16])).toBe(16);
        expect(loopLength([16, 24])).toBe(48);
        expect(loopLength([4, 8, 12, 16, 24, 32, 48, 64])).toBe(192);
        expect(loopLength([])).toBe(32);
    });
});

describe('planRender', () => {
    it('keeps only the container for a loop and turns microphone tracks into samplers', () => {
        const plan = planRender(session(), { kind: 'container', containerId: 'a', repeats: 2 });
        expect(plan.mode).toBe('loop');
        expect(plan.state.containers.map((container) => container.id)).toEqual(['a']);
        expect(plan.state.currentContainerId).toBe('a');
        expect(plan.state.containers[0]!.tracks.map((t) => t.type)).toEqual(['synth', 'sampler']);
        expect(plan.state.containers[0]!.tracks[1]!.isMuted).toBe(true);
        expect(plan.steps).toBe(48 * 2);
    });

    it('plays a single track alone and unmuted', () => {
        const plan = planRender(session(), { kind: 'track', containerId: 'a', trackId: 't2', repeats: 1 });
        expect(plan.state.containers[0]!.tracks).toHaveLength(1);
        expect(plan.state.containers[0]!.tracks[0]).toMatchObject({ id: 't2', type: 'sampler', isMuted: false });
        expect(plan.steps).toBe(24);
    });

    it('renders the arrangement in song mode for as long as the song is', () => {
        const state = session();
        const song = new Song();
        song.restore(state.song);
        song.addClip(song.lanes[0]!.id, 'a', 16, 20);
        state.song = song.capture();

        const plan = planRender(state, { kind: 'song' });
        expect(plan.mode).toBe('song');
        expect(plan.state.containers).toHaveLength(2);
        expect(plan.steps).toBe(48);
    });

    it('refuses an empty song and unknown targets', () => {
        expect(() => planRender(session(), { kind: 'song' })).toThrow(RenderError);
        expect(() => planRender(session(), { kind: 'container', containerId: 'zzz', repeats: 1 })).toThrow(RenderError);
        expect(() => planRender(session(), { kind: 'track', containerId: 'a', trackId: 'zzz', repeats: 1 })).toThrow(RenderError);
    });

    it('leaves the captured session alone', () => {
        const state = session();
        planRender(state, { kind: 'track', containerId: 'a', trackId: 't2', repeats: 1 });
        expect(state.containers).toHaveLength(2);
        expect(state.containers[0]!.tracks[1]).toMatchObject({ type: 'microphone', isMuted: true });
    });
});

describe('renderDuration', () => {
    it('is the steps at the tempo plus the tail', () => {
        expect(secondsPerStep(120)).toBeCloseTo(0.125);
        const plan = planRender(session(), { kind: 'track', containerId: 'a', trackId: 't1', repeats: 4 });
        expect(renderDuration(plan, { bpm: 120, tail: 2 })).toBeCloseTo(64 * 0.125 + 2);
        expect(renderDuration(plan, { bpm: 120, tail: -5 })).toBeCloseTo(8);
    });
});

describe('dynamicsInPath', () => {
    const compressing = (snapshot: LegacyEffectsSnapshot): LegacyEffectsSnapshot => ({ ...snapshot, params: { ...snapshot.params, compressor: { ...snapshot.params.compressor, ratio: 4 } } });
    const limiting = (snapshot: LegacyEffectsSnapshot): LegacyEffectsSnapshot => ({ ...snapshot, params: { ...snapshot.params, limiter: { ...snapshot.params.limiter, on: 1 } } });

    it('is just the master limiter for a fresh session', () => {
        expect(dynamicsInPath(session())).toBe(1);
    });

    it('is none when the master limiter is off too', () => {
        const state = session();
        (state.master.effects as LegacyEffectsSnapshot).params.limiter.on = 0;
        expect(dynamicsInPath(state)).toBe(0);
    });

    it('takes the path with the most compressors and limiters', () => {
        const state = session();
        state.containers[0]!.tracks[0]!.effects = compressing(state.containers[0]!.tracks[0]!.effects as LegacyEffectsSnapshot);
        state.containers[1]!.bus.effects = limiting(compressing(state.containers[1]!.bus.effects as LegacyEffectsSnapshot));
        state.containers[1]!.tracks[0]!.effects = compressing(state.containers[1]!.tracks[0]!.effects as LegacyEffectsSnapshot);
        // Container b: track compressor + bus compressor and limiter + master limiter.
        expect(dynamicsInPath(state)).toBe(4);
    });

    it('does not count a muted track, but still the bus of a container that has only muted tracks', () => {
        const state = session();
        state.containers[0]!.tracks[1]!.effects = limiting(compressing(state.containers[0]!.tracks[1]!.effects as LegacyEffectsSnapshot));
        expect(dynamicsInPath(state)).toBe(1);

        state.containers[1]!.tracks[0]!.isMuted = true;
        state.containers[1]!.bus.effects = compressing(state.containers[1]!.bus.effects as LegacyEffectsSnapshot);
        expect(dynamicsInPath(state)).toBe(2);
    });

    it('counts the limiter of an old rack without a switch as on', () => {
        const state = session();
        const old = effects();
        old.params.limiter = { threshold: -1 };
        old.params.compressor = { ...old.params.compressor, ratio: 12 };
        state.containers[0]!.tracks[0]!.effects = old;
        state.containers[0]!.bus.effects = old;
        state.master.effects = old;
        // Before the change every rack had both stages: three racks, six look-ahead nodes.
        expect(dynamicsInPath(state)).toBe(6);
    });
});
