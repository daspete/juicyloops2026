import { describe, expect, it } from 'vitest';
import type { SessionState } from '../sequencer';
import { packSession, sessionFileName, sessionNameOf, SessionFileError, unpackSession, type SavedSession } from '../sessionFile';
import type { SampleTrackState } from '../tracks/SampleTrack';
import type { SynthTrackState } from '../tracks/SynthTrack';
import type { TrackState } from '../tracks/BaseTrack';
import type { SampleTickSnapshot } from '../ticks/SampleTick';
import type { SynthTickSnapshot } from '../ticks/SynthTick';

const synthTick: SynthTickSnapshot = { isActive: true, volume: 1, note: 'C5', duration: '16n' };
const sampleTick: SampleTickSnapshot = { isActive: true, volume: 0.8, pitch: 2 };

const effects = { order: [], params: {} } as unknown as TrackState['effects'];

const synth = (id: string): SynthTrackState => ({
    id,
    type: 'synth',
    ticks: [synthTick],
    volume: -3,
    pan: 0.25,
    isMuted: false,
    effects,
    automation: [{ param: 'volume', points: [{ step: 0, value: 0.5 }] }],
    oscillatorType: 'square',
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 1 },
});

const sample = (id: string, type: 'sampler' | 'microphone', blob: Blob | null, name: string | null): SampleTrackState => ({
    id,
    type,
    ticks: [sampleTick],
    volume: 0,
    pan: 0,
    isMuted: true,
    effects,
    automation: [],
    sampleBlob: blob,
    sampleName: name,
    sampleStartTime: 0.1,
    sampleDuration: 0.5,
    isReversed: true,
});

const bytes = (...values: number[]) => new Blob([new Uint8Array(values)], { type: 'audio/wav' });

const session = (tracks: TrackState[]): SessionState => ({
    containers: [{ id: 'c1', name: 'Verse', bus: { volume: -1, pan: 0, effects }, tracks }],
    currentContainerId: 'c1',
    song: { lanes: [{ id: 'l1', name: 'Lane 1', isMuted: false, clips: [{ id: 'k1', containerId: 'c1', start: 0, length: 32, offset: 0 }] }], automation: [] },
    master: { volume: 0, pan: 0, effects },
});

const roundTrip = async (saved: SavedSession): Promise<SavedSession> => unpackSession(await packSession(saved).arrayBuffer());

describe('session file', () => {
    it('brings back everything that is not audio unchanged', async () => {
        const saved: SavedSession = { name: 'My loop', bpm: 128, session: session([synth('s1')]) };
        const loaded = await roundTrip(saved);
        expect(loaded).toEqual(saved);
    });

    it('stores samples and recordings and brings them back as the same audio', async () => {
        const file = bytes(1, 2, 3, 4, 5);
        const recording = new Blob([new Uint8Array([9, 8, 7])], { type: 'audio/webm' });
        const saved: SavedSession = {
            name: 'With audio',
            bpm: 90,
            session: session([sample('a', 'sampler', file, 'kick.wav'), sample('b', 'microphone', recording, 'Recording'), sample('c', 'sampler', null, null)]),
        };

        const loaded = await roundTrip(saved);
        const tracks = loaded.session.containers[0]!.tracks as SampleTrackState[];

        expect(tracks.map((track) => track.sampleName)).toEqual(['kick.wav', 'Recording', null]);
        expect(tracks[2]!.sampleBlob).toBeNull();
        expect(tracks[0]!.sampleBlob?.type).toBe('audio/wav');
        expect(tracks[1]!.sampleBlob?.type).toBe('audio/webm');
        expect(new Uint8Array(await tracks[0]!.sampleBlob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        expect(new Uint8Array(await tracks[1]!.sampleBlob!.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
        // The slice, the direction and the pattern travel with the sample.
        expect(tracks[0]).toMatchObject({ sampleStartTime: 0.1, sampleDuration: 0.5, isReversed: true, isMuted: true });
        expect(tracks[0]!.ticks[0]).toEqual({ isActive: true, volume: 0.8, pitch: 2 });
        expect((tracks[0] as unknown as Record<string, unknown>).sampleAsset).toBeUndefined();
    });

    it('writes a sample that two tracks share only once', async () => {
        const shared = new Blob([new Uint8Array(20000).map((_, i) => i % 251)], { type: 'audio/wav' });
        const saved: SavedSession = { name: 'Shared', bpm: 120, session: session([sample('a', 'sampler', shared, 'x'), sample('b', 'sampler', shared, 'x')]) };
        const single: SavedSession = { name: 'Shared', bpm: 120, session: session([sample('a', 'sampler', shared, 'x')]) };

        const packed = packSession(saved);
        const packedOnce = packSession(single);
        // The second track adds its bit of header, but not a second copy of the audio.
        expect(packed.size).toBeLessThan(packedOnce.size + shared.size);

        const loaded = await roundTrip(saved);
        const tracks = loaded.session.containers[0]!.tracks as SampleTrackState[];
        expect(new Uint8Array(await tracks[1]!.sampleBlob!.arrayBuffer())).toEqual(new Uint8Array(await shared.arrayBuffer()));
    });

    it('refuses what is not a session file, with a readable reason', async () => {
        expect(() => unpackSession(new TextEncoder().encode('hello world, this is not it').buffer)).toThrow(SessionFileError);
        expect(() => unpackSession(new ArrayBuffer(3))).toThrow('not a JuicyLoops file');

        const packed = await packSession({ name: 'x', bpm: 100, session: session([sample('a', 'sampler', bytes(1, 2, 3), 'x')]) }).arrayBuffer();
        expect(() => unpackSession(packed.slice(0, packed.byteLength - 2))).toThrow('cut off');
    });

    it('turns names into file names and back', () => {
        expect(sessionFileName('My loop')).toBe('My loop.juicyloops');
        expect(sessionFileName('a/b:c?')).toBe('a-b-c-.juicyloops');
        expect(sessionFileName('   ')).toBe('untitled.juicyloops');
        expect(sessionNameOf('My loop.juicyloops')).toBe('My loop');
        expect(sessionNameOf('plain')).toBe('plain');
    });
});
