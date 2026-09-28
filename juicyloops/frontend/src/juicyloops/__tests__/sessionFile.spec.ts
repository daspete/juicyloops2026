import { describe, expect, it } from 'vitest';
import type { SessionState } from '../sequencer';
import { packSession, sessionFileName, sessionNameOf, SessionFileError, unpackSession, type SavedSession } from '../sessionFile';
import type { SampleTrackState } from '../tracks/SampleTrack';
import type { SynthTrackState } from '../tracks/SynthTrack';
import type { TrackState } from '../tracks/BaseTrack';
import type { PatternNote } from '../notes/Note';
import { ticksToNotes, upgradeTrackState, type LegacyTrackState } from '../notes/migrate';

const synthNote: PatternNote = { id: 'n1', note: 'C5', start: 0, length: 1.5, velocity: 1 };
const sampleNote: PatternNote = { id: 'n2', note: 'D5', start: 2.25, length: 1, velocity: 0.8 };

const effects = { order: [], params: {} } as unknown as TrackState['effects'];

const synth = (id: string): SynthTrackState => ({
    id,
    type: 'synth',
    length: 16,
    notes: [synthNote],
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
    length: 32,
    notes: [sampleNote],
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
    pitch: -3,
    speed: 1.5,
    cuts: [0.2, 0.4],
    gate: true,
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
        expect(tracks[0]).toMatchObject({ sampleStartTime: 0.1, sampleDuration: 0.5, isReversed: true, isMuted: true, pitch: -3, speed: 1.5, cuts: [0.2, 0.4], gate: true });
        expect(tracks[0]!.notes).toEqual([sampleNote]);
        expect(tracks[0]!.length).toBe(32);
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

    it('keeps MIDI mappings, pitch bend and its range', async () => {
        const bent: SynthTrackState = { ...synth('s9'), bend: -0.25, bendRange: 12 };
        const state: SessionState = {
            ...session([bent]),
            midiMappings: [
                { cc: 74, channel: 0, target: { kind: 'track', containerId: 'c1', trackId: 's9' }, param: 'envelope.attack' },
                { cc: 7, channel: 'all', target: { kind: 'master' }, param: 'volume' },
            ],
        };
        const loaded = await roundTrip({ name: 'Mapped', bpm: 120, session: state });
        expect(loaded.session.midiMappings).toEqual(state.midiMappings);
        const track = loaded.session.containers[0]!.tracks[0] as SynthTrackState;
        expect(track.bend).toBe(-0.25);
        expect(track.bendRange).toBe(12);
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

    it('writes version 2', async () => {
        const packed = new Uint8Array(await packSession({ name: 'x', bpm: 100, session: session([synth('s1')]) }).arrayBuffer());
        const length = new DataView(packed.buffer).getUint32(8, true);
        const header = JSON.parse(new TextDecoder().decode(packed.subarray(12, 12 + length)));
        expect(header.version).toBe(2);
    });
});

/* ---- version 1: ticks instead of notes ---- */

/** A file as version 1 wrote it, byte for byte: magic, header length, header JSON, assets. */
const v1File = (header: object, assets: Uint8Array[]): ArrayBuffer => {
    const json = new TextEncoder().encode(JSON.stringify(header));
    const length = new DataView(new ArrayBuffer(4));
    length.setUint32(0, json.byteLength, true);
    const parts = [new TextEncoder().encode('JUICYLPS'), new Uint8Array(length.buffer), json, ...assets];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out.buffer;
};

const tick = (isActive: boolean, volume: number, extra: object = {}) => ({ isActive, volume, ...extra });

const V1_HEADER = {
    format: 'juicyloops',
    version: 1,
    savedAt: '2026-09-01T00:00:00.000Z',
    name: 'Old loop',
    bpm: 120,
    session: {
        containers: [
            {
                id: 'c1',
                name: 'Verse',
                bus: { volume: -1, pan: 0, effects },
                tracks: [
                    {
                        id: 's1',
                        type: 'synth',
                        ticks: [
                            tick(true, 1, { note: 'C4', duration: '16n' }),
                            tick(false, 0.3, { note: 'B7', duration: '2n' }),
                            tick(true, 0.5, { note: 'E4', duration: '64n' }),
                            tick(true, 0.8, { note: 'G4', duration: '2n' }),
                            ...Array.from({ length: 8 }, () => tick(false, 1, { note: 'C5', duration: '16n' })),
                        ],
                        volume: -3,
                        pan: 0.25,
                        isMuted: false,
                        effects,
                        automation: [{ param: 'volume', points: [{ step: 0, value: 0.5 }] }],
                        cutsNotes: true,
                        oscillatorType: 'square',
                        envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 1 },
                    },
                    {
                        id: 'p1',
                        type: 'sampler',
                        ticks: [tick(true, 0.6, { note: 'D5' }), tick(true, 1, { pitch: 3 }), tick(false, 1, { note: 'C5' }), tick(true, 1)],
                        volume: 0,
                        pan: 0,
                        isMuted: false,
                        effects,
                        automation: [],
                        sampleAsset: 0,
                        sampleName: 'kick.wav',
                        sampleStartTime: 0,
                        sampleDuration: 0.5,
                        isReversed: false,
                        pitch: 0,
                        speed: 1,
                        cuts: [],
                    },
                ],
            },
        ],
        currentContainerId: 'c1',
        song: { lanes: [{ id: 'l1', name: 'Lane 1', isMuted: false, clips: [{ id: 'k1', containerId: 'c1', start: 0, length: 32, offset: 0 }] }], automation: [] },
        master: { volume: 0, pan: 0, effects },
    },
    assets: [{ type: 'audio/wav', size: 3 }],
};

const withoutIds = (notes: readonly PatternNote[]) => notes.map(({ note, start, length, velocity }) => ({ note, start, length, velocity }));

describe('session file version 1', () => {
    it('turns every active tick into a note on its step and drops inactive ones', async () => {
        const loaded = unpackSession(v1File(V1_HEADER, [new Uint8Array([1, 2, 3])]));
        const [synthTrack, sampler] = loaded.session.containers[0]!.tracks as [SynthTrackState, SampleTrackState];

        expect(synthTrack.length).toBe(12);
        expect(withoutIds(synthTrack.notes)).toEqual([
            { note: 'C4', start: 0, length: 1, velocity: 1 },
            { note: 'E4', start: 2, length: 0.25, velocity: 0.5 },
            { note: 'G4', start: 3, length: 8, velocity: 0.8 },
        ]);
        expect('ticks' in synthTrack).toBe(false);
        // Everything else comes through untouched.
        expect(synthTrack).toMatchObject({ volume: -3, pan: 0.25, cutsNotes: true, oscillatorType: 'square', automation: [{ param: 'volume', points: [{ step: 0, value: 0.5 }] }] });

        expect(sampler.length).toBe(4);
        // Sample notes are one step long; a tick from before notes gave its pitch in semitones above the root.
        expect(withoutIds(sampler.notes)).toEqual([
            { note: 'D5', start: 0, length: 1, velocity: 0.6 },
            { note: 'D#5', start: 1, length: 1, velocity: 1 },
            { note: 'C5', start: 3, length: 1, velocity: 1 },
        ]);
        expect(sampler.gate).toBeUndefined();
        expect(new Uint8Array(await sampler.sampleBlob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('round-trips: a converted file saves as version 2 and loads the same', async () => {
        const loaded = unpackSession(v1File(V1_HEADER, [new Uint8Array([1, 2, 3])]));
        const again = await roundTrip(loaded);
        expect(again.session.containers[0]!.tracks.map((track) => track.notes)).toEqual(loaded.session.containers[0]!.tracks.map((track) => track.notes));
        expect(again).toMatchObject({ name: 'Old loop', bpm: 120 });
    });

    it('converts ticks in history states too, and leaves states with notes alone', () => {
        const legacy = { ...synth('s2'), notes: undefined, length: undefined, ticks: [tick(false, 1), tick(true, 0.4, { note: 'A3', duration: '8n' })] } as unknown as LegacyTrackState;
        const upgraded = upgradeTrackState<SynthTrackState>(legacy);
        expect(upgraded.length).toBe(2);
        expect(withoutIds(upgraded.notes)).toEqual([{ note: 'A3', start: 1, length: 2, velocity: 0.4 }]);

        const current = synth('s3');
        expect(upgradeTrackState(current)).toBe(current);
        expect(ticksToNotes([], 'synth')).toEqual([]);
    });
});
