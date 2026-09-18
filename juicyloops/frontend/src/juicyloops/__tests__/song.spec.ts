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
});
