import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RECORDER_PROCESSOR, type RecorderCommand, type RecorderEvent } from '../dsp/recorderProtocol';
import type { EffectsSnapshot } from '../effects/effects';
import { liveOnlyPlugins, LiveTake, mixChangesFor } from '../liveRender';
import { planRender } from '../render';
import type { SessionState } from '../sequencer';
import { Song } from '../song';
import type { TrackState } from '../tracks/BaseTrack';

/*
 * The real-time export needs a running audio context, so the recording itself is checked in the browser. Here: the
 * recorder processor in Node (the worklet scope's globals stubbed, as for the synth processor), and the pure planning.
 */

const PRO54 = 'https://cesaref.github.io/wam/Pro54/index.js';
const OBXD = 'https://mainline.i3s.unice.fr/wam2/packages/obxd/index.js';
const SYNTH_101 = 'https://www.webaudiomodules.com/community/plugins/burns-audio/synth101/index.js';

const rack = (...plugins: { url: string; name: string }[]): EffectsSnapshot => ({
    slots: plugins.map((plugin, index) => ({ id: `plugin${index}`, effect: 'plugin', bypassed: false, params: {}, plugin })),
});

const track = (id: string, extra: Partial<TrackState> & Record<string, unknown> = {}): TrackState => ({
    id,
    type: 'synth',
    length: 16,
    notes: [],
    volume: 0,
    pan: 0,
    isMuted: false,
    effects: rack(),
    automation: [],
    ...extra,
});

const session = (): SessionState => ({
    containers: [
        { id: 'a', name: 'A', bus: { volume: 0, pan: 0, effects: rack() }, tracks: [track('t1'), track('t2', { isMuted: true }), track('t3', { isSolo: true })] },
        { id: 'b', name: 'B', bus: { volume: 0, pan: 0, effects: rack(), isSolo: true }, tracks: [track('t4', { isSolo: true }), track('t5')] },
    ],
    currentContainerId: 'a',
    song: new Song().capture(),
    master: { volume: 0, pan: 0, effects: rack() },
});

describe('liveOnlyPlugins', () => {
    it('finds live-only plugin synths and effect slots, each once, and ignores the rest', () => {
        const state = session();
        state.containers[0]!.tracks[0] = track('t1', { model: 'plugin', plugin: { url: PRO54, name: 'Pro-54' } });
        state.containers[0]!.tracks[1] = track('t2', { model: 'plugin', plugin: { url: OBXD, name: 'OB-Xd' } });
        state.containers[1]!.tracks[0] = track('t4', { model: 'plugin', plugin: { url: PRO54, name: 'Pro-54' } });
        state.master.effects = rack({ url: SYNTH_101, name: 'Synth-101' });
        expect(liveOnlyPlugins(state)).toEqual(['Pro-54', 'Synth-101']);
    });

    it('does not count a plugin left on a synth that plays another model', () => {
        const state = session();
        state.containers[0]!.tracks[0] = track('t1', { model: 'analog', plugin: { url: PRO54, name: 'Pro-54' } });
        expect(liveOnlyPlugins(state)).toEqual([]);
    });

    it('asks only about what a scope plays when given the planned state', () => {
        const state = session();
        state.containers[1]!.tracks[1] = track('t5', { model: 'plugin', plugin: { url: PRO54, name: 'Pro-54' } });
        expect(liveOnlyPlugins(planRender(state, { kind: 'container', containerId: 'a', repeats: 1 }).state)).toEqual([]);
        expect(liveOnlyPlugins(planRender(state, { kind: 'container', containerId: 'b', repeats: 1 }).state)).toEqual(['Pro-54']);
        expect(liveOnlyPlugins(planRender(state, { kind: 'track', containerId: 'b', trackId: 't4', repeats: 1 }).state)).toEqual([]);
    });
});

describe('mixChangesFor', () => {
    it('leaves the song as it is', () => {
        expect(mixChangesFor(session(), { kind: 'song' })).toEqual({ apply: [], undo: [] });
    });

    it('switches off every solo outside a container, and puts it back', () => {
        const { apply, undo } = mixChangesFor(session(), { kind: 'container', containerId: 'a', repeats: 1 });
        expect(apply).toEqual([
            { containerId: 'b', isSolo: false },
            { containerId: 'b', trackId: 't4', isSolo: false },
        ]);
        expect(undo).toEqual([
            { containerId: 'b', isSolo: true },
            { containerId: 'b', trackId: 't4', isSolo: true },
        ]);
    });

    it('solos and unmutes a single track, and only that one', () => {
        const { apply, undo } = mixChangesFor(session(), { kind: 'track', containerId: 'a', trackId: 't2', repeats: 1 });
        expect(apply).toEqual([
            { containerId: 'a', trackId: 't2', isSolo: true },
            { containerId: 'a', trackId: 't2', isMuted: false },
            { containerId: 'a', trackId: 't3', isSolo: false },
            { containerId: 'b', isSolo: false },
            { containerId: 'b', trackId: 't4', isSolo: false },
        ]);
        expect(undo).toEqual([
            { containerId: 'a', trackId: 't2', isSolo: false },
            { containerId: 'a', trackId: 't2', isMuted: true },
            { containerId: 'a', trackId: 't3', isSolo: true },
            { containerId: 'b', isSolo: true },
            { containerId: 'b', trackId: 't4', isSolo: true },
        ]);
    });

    it('changes nothing for a track that is already the only solo', () => {
        const state = session();
        state.containers[1]!.bus.isSolo = false;
        state.containers[1]!.tracks[0]!.isSolo = false;
        expect(mixChangesFor(state, { kind: 'track', containerId: 'a', trackId: 't3', repeats: 1 })).toEqual({ apply: [], undo: [] });
    });
});

describe('LiveTake', () => {
    it('places chunks at their offsets and drops what runs past the end', () => {
        const take = new LiveTake(5, 48000);
        take.add(3, Float32Array.of(4, 5, 6), Float32Array.of(-4, -5, -6));
        take.add(0, Float32Array.of(1, 2, 3), Float32Array.of(-1, -2, -3));
        expect(take.isComplete).toBe(true);
        const audio = take.toAudio();
        expect(audio.numberOfChannels).toBe(2);
        expect(audio.length).toBe(5);
        expect([...audio.getChannelData(0)]).toEqual([1, 2, 3, 4, 5]);
        expect([...audio.getChannelData(1)]).toEqual([-1, -2, -3, -4, -5]);
    });
});

describe('recorder processor', () => {
    const RATE = 48000;
    const BLOCK = 128;

    type Port = { onmessage: ((event: { data: RecorderCommand }) => void) | null; posted: RecorderEvent[]; postMessage(event: RecorderEvent): void };
    type Processor = { port: Port; process(inputs: Float32Array[][]): boolean };
    let Processor: new () => Processor;
    let registeredAs = '';

    beforeAll(async () => {
        vi.stubGlobal('sampleRate', RATE);
        vi.stubGlobal('currentFrame', 0);
        vi.stubGlobal(
            'AudioWorkletProcessor',
            class {
                readonly port = {
                    onmessage: null,
                    posted: [] as RecorderEvent[],
                    postMessage(event: RecorderEvent) {
                        this.posted.push(event);
                    },
                };
            },
        );
        vi.stubGlobal('registerProcessor', (name: string, processor: typeof Processor) => {
            registeredAs = name;
            Processor = processor;
        });
        await import('../dsp/recorderProcessor');
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    /** A ramp input: frame n of the context carries n (left) and -n (right), so every recorded sample says where it came from. */
    const ramp = (from: number, channels = 2): Float32Array[] =>
        Array.from({ length: channels }, (_, side) => Float32Array.from({ length: BLOCK }, (_, i) => (side ? -1 : 1) * (from + i)));

    const create = () => {
        const processor = new Processor();
        const send = (command: RecorderCommand) => processor.port.onmessage!({ data: command });
        /** Runs blocks from frame `from` up to (not including) `to`, as the audio thread does. */
        const run = (from: number, to: number, input: (frame: number) => Float32Array[][] = (frame) => [ramp(frame)]) => {
            let alive = true;
            for (let frame = from; frame < to; frame += BLOCK) {
                vi.stubGlobal('currentFrame', frame);
                alive = processor.process(input(frame));
            }
            return alive;
        };
        /** The recording assembled from the posted chunks, like `LiveRecorder` does. */
        const recording = (frames: number) => {
            const take = new LiveTake(frames, RATE);
            for (const event of processor.port.posted) {
                if (event.type === 'chunk') {
                    take.add(event.offset, event.left, event.right);
                }
            }
            return take;
        };
        return { processor, send, run, recording, posted: processor.port.posted };
    };

    it('registers under the name the main thread asks for', () => {
        expect(registeredAs).toBe(RECORDER_PROCESSOR);
    });

    it('keeps exactly the frames asked for, from the start frame on, even in the middle of a block', () => {
        const { send, run, recording, posted } = create();
        const start = 1000;
        const frames = 40000;
        send({ type: 'record', frame: start, frames });
        run(0, 60000);
        const take = recording(frames);
        expect(take.received).toBe(frames);
        expect(take.left[0]).toBe(start);
        expect(take.left[frames - 1]).toBe(start + frames - 1);
        expect(take.right[12345]).toBe(-(start + 12345));
        expect(take.left.every((sample, i) => sample === start + i)).toBe(true);
        expect(posted[posted.length - 1]).toEqual({ type: 'done', frames });
        expect(posted.filter((event) => event.type === 'done')).toHaveLength(1);
        // Chunks of 16384 frames, and the rest.
        expect(posted.filter((event) => event.type === 'chunk').map((event) => (event.type === 'chunk' ? event.left.length : 0))).toEqual([16384, 16384, 7232]);
    });

    it('records nothing before it is armed and nothing after its end', () => {
        const { send, run, posted } = create();
        run(0, 4096);
        expect(posted).toEqual([]);
        send({ type: 'record', frame: 4096, frames: 100 });
        run(4096, 20000);
        expect(posted.map((event) => event.type)).toEqual(['chunk', 'done']);
    });

    it('copies a mono input to both sides and counts a block without input as silence', () => {
        const { send, run, recording } = create();
        send({ type: 'record', frame: 0, frames: BLOCK * 3 });
        run(0, BLOCK * 3, (frame) => (frame === BLOCK ? [[]] : [ramp(frame, 1)]));
        const take = recording(BLOCK * 3);
        expect(take.left[5]).toBe(5);
        expect(take.right[5]).toBe(5);
        expect(take.left[BLOCK + 5]).toBe(0);
        expect(take.right[BLOCK + 5]).toBe(0);
        expect(take.left[2 * BLOCK + 5]).toBe(2 * BLOCK + 5);
    });

    it('reports a start frame that has already played instead of recording with a gap', () => {
        const { send, run, posted } = create();
        run(0, 1024);
        send({ type: 'record', frame: 1000, frames: 500 });
        run(1024, 4096);
        expect(posted).toEqual([{ type: 'late', missed: 24 }]);
    });

    it('drops a cancelled recording and lets the node go after dispose', () => {
        const { send, run, posted } = create();
        send({ type: 'record', frame: 0, frames: 30000 });
        run(0, 20000);
        send({ type: 'cancel' });
        expect(run(20000, 40000)).toBe(true);
        expect(posted.map((event) => event.type)).toEqual(['chunk']);
        send({ type: 'dispose' });
        expect(run(40000, 40128)).toBe(false);
    });
});
