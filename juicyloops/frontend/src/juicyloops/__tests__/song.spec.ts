import { describe, expect, it } from 'vitest';
import { Song, SONG_STEPS_PER_BAR, snapStep } from '../song';

const songWithClip = () => {
    const song = new Song();
    const lane = song.lanes[0]!;
    const clip = song.addClip(lane.id, 'a', 16, 32)!;
    return { song, lane, clip };
};

describe('Song', () => {
    it('starts with one empty lane and never has fewer', () => {
        const song = new Song(0);
        expect(song.lanes).toHaveLength(1);
        expect(song.isEmpty).toBe(true);
        expect(song.length).toBe(0);

        song.removeLane(song.lanes[0]!.id);
        expect(song.lanes).toHaveLength(1);
    });

    it('snaps clips to the grid and measures the song in whole bars', () => {
        const song = new Song();
        const lane = song.lanes[0]!;
        const clip = song.addClip(lane.id, 'a', 5, 30)!;

        expect(snapStep(5)).toBe(4);
        expect(clip.start).toBe(4);
        expect(clip.length).toBe(32);
        expect(song.length).toBe(3 * SONG_STEPS_PER_BAR);
        expect(song.countClips('a')).toBe(1);
    });

    it('refuses overlapping clips on one lane', () => {
        const { song, lane } = songWithClip();
        expect(song.addClip(lane.id, 'b', 40, 8)).toBeNull();
        expect(song.addClip(lane.id, 'b', 48, 8)).not.toBeNull();
        expect(song.addClip(lane.id, 'b', 0, 16)).not.toBeNull();
    });

    it('tells what plays at a step, once per container, skipping muted lanes', () => {
        const { song, lane, clip } = songWithClip();
        const other = song.addLane();
        song.addClip(other.id, 'a', 0, 64);
        song.addClip(other.id, 'b', 64, 16)!;

        expect(song.playingAt(15)).toEqual(new Map([['a', 15]]));
        expect(song.playingAt(20)).toEqual(new Map([['a', 4]]));
        expect(song.playingAt(70)).toEqual(new Map([['b', 6]]));
        expect(song.playingAt(90).size).toBe(0);

        lane.isMuted = true;
        expect(song.playingAt(20)).toEqual(new Map([['a', 20]]));
        expect(clip.offset).toBe(0);
    });

    it('refills a given map instead of making a new one (the step callback reuses one)', () => {
        const { song } = songWithClip();
        const into = new Map([['stale', 1]]);

        expect(song.playingAt(20, into)).toBe(into);
        expect(into).toEqual(new Map([['a', 4]]));
        expect(song.playingAt(90, into).size).toBe(0);
    });

    it('moves clips between lanes when the spot is free', () => {
        const { song, lane, clip } = songWithClip();
        const other = song.addLane();
        song.addClip(other.id, 'b', 0, 32);

        expect(song.moveClip(clip.id, 8, other.id)).toBe(false);
        expect(song.laneOf(clip.id)).toBe(lane);

        expect(song.moveClip(clip.id, 32, other.id)).toBe(true);
        expect(song.laneOf(clip.id)).toBe(other);
        expect(clip.start).toBe(32);
        expect(other.clips.map((c) => c.start)).toEqual([0, 32]);
    });

    it('resizes from either edge without running into neighbours', () => {
        const { song, lane, clip } = songWithClip();
        song.addClip(lane.id, 'b', 64, 16);

        song.setClipEnd(clip.id, 100);
        expect(clip.length).toBe(48);
        song.setClipEnd(clip.id, 2);
        expect(clip.length).toBe(4);

        song.setClipEnd(clip.id, 48);
        song.setClipStart(clip.id, 24);
        expect(clip.start).toBe(24);
        expect(clip.length).toBe(24);
        expect(clip.offset).toBe(8);

        song.setClipStart(clip.id, -50);
        expect(clip.start).toBe(0);
        expect(clip.offset).toBe(-16);
        expect(song.playingAt(16)).toEqual(new Map([['a', 0]]));
    });

    it('splits, duplicates and removes clips', () => {
        const { song, lane, clip } = songWithClip();

        expect(song.splitClip(clip.id, 16)).toBeNull();
        const right = song.splitClip(clip.id, 32)!;
        expect(clip.length).toBe(16);
        expect(right).toMatchObject({ containerId: 'a', start: 32, length: 16, offset: 16 });
        expect(song.playingAt(40)).toEqual(new Map([['a', 24]]));

        const copy = song.duplicateClip(right.id)!;
        expect(copy.start).toBe(48);
        expect(song.duplicateClip(clip.id)).toBeNull();

        song.removeClip(clip.id);
        song.removeContainer('a');
        expect(lane.clips).toHaveLength(0);
        expect(song.isEmpty).toBe(true);
    });

    it('adds, reorders and removes lanes', () => {
        const song = new Song(2);
        const [first, second] = song.lanes;
        song.moveLane(second!.id, -1);
        expect(song.lanes[0]).toBe(second);
        song.moveLane(second!.id, -1);
        expect(song.lanes[0]).toBe(second);

        song.removeLane(second!.id);
        expect(song.lanes).toEqual([first]);
    });

    it('silences muted clips and every lane but the soloed ones', () => {
        const { song, lane, clip } = songWithClip();
        const other = song.addLane();
        song.addClip(other.id, 'b', 16, 16);

        clip.isMuted = true;
        expect(song.playingAt(20)).toEqual(new Map([['b', 4]]));
        clip.isMuted = false;

        lane.isSolo = true;
        expect(song.playingAt(20)).toEqual(new Map([['a', 4]]));
        lane.isMuted = true;
        expect(song.playingAt(20)).toEqual(new Map([['a', 4]]));
    });

    it('snaps to the editing grid', () => {
        const song = new Song();
        const lane = song.lanes[0]!;
        song.grid = 1;
        expect(song.addClip(lane.id, 'a', 5, 3)).toMatchObject({ start: 5, length: 3 });
        song.grid = SONG_STEPS_PER_BAR;
        expect(song.addClip(lane.id, 'a', 20, 20)).toMatchObject({ start: 16, length: 16 });
    });

    it('moves and copies several clips together, all or nothing', () => {
        const { song, lane, clip } = songWithClip();
        const other = song.addLane();
        const below = song.addClip(other.id, 'b', 48, 16)!;

        expect(song.canMoveClips([clip.id, below.id], -16, 0)).toBe(true);
        expect(song.canMoveClips([clip.id, below.id], -32, 0)).toBe(false);
        expect(song.canMoveClips([clip.id, below.id], 0, 1)).toBe(false);

        expect(song.moveClips([clip.id, below.id], 16, 0)).toBe(true);
        expect(clip.start).toBe(32);
        expect(below.start).toBe(64);

        expect(song.moveClips([clip.id], 0, 1)).toBe(true);
        expect(song.laneOf(clip.id)).toBe(other);
        expect(lane.clips).toHaveLength(0);

        expect(song.copyClips([clip.id], 0, 0)).toBeNull();
        const copies = song.copyClips([clip.id], 0, -1)!;
        expect(copies).toHaveLength(1);
        expect(lane.clips[0]).toMatchObject({ start: 32, length: 32, containerId: 'a' });
    });

    it('duplicates a selection right behind itself and pastes clips where asked', () => {
        const { song, lane, clip } = songWithClip();
        const other = song.addLane();
        song.addClip(other.id, 'b', 0, 16);
        clip.isMuted = true;

        const copies = song.duplicateClips(song.clips.map((candidate) => candidate.id))!;
        expect(copies.map((copy) => copy.start).sort((a, b) => a - b)).toEqual([48, 64]);
        expect(lane.clips.map((candidate) => candidate.start)).toEqual([16, 64]);
        expect(lane.clips[1]!.isMuted).toBe(true);

        expect(song.placeClips([{ laneId: lane.id, containerId: 'c', start: 0, length: 16 }])).toHaveLength(1);
        expect(song.placeClips([{ laneId: lane.id, containerId: 'c', start: 90, length: 8 }, { laneId: lane.id, containerId: 'c', start: 0, length: 8 }])).toBeNull();
        expect(song.clips.some((candidate) => candidate.start === 90)).toBe(false);
    });

    it('inserts and clears lanes, and restores solo', () => {
        const { song, lane } = songWithClip();
        const first = song.addLane('First', 0);
        expect(song.lanes[0]).toBe(first);

        lane.isSolo = true;
        const state = song.capture();
        song.clearLane(lane.id);
        lane.isSolo = false;
        expect(lane.clips).toHaveLength(0);

        song.restore(state);
        expect(lane.clips).toHaveLength(1);
        expect(lane.isSolo).toBe(true);
    });
});
