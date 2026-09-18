import { describe, expect, it } from 'vitest';
import { setPoint } from '../automation';
import { Song } from '../song';

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
