import { describe, expect, it } from 'vitest';
import { Song } from '../song';

describe('Song', () => {
    it('starts with empty sections and never has fewer than one', () => {
        expect(new Song(3).length).toBe(3);
        expect(new Song(0).length).toBe(1);
        expect(new Song().isEmpty).toBe(true);
    });

    it('toggles tracks per section', () => {
        const song = new Song(2);
        song.toggle(1, 'a');

        expect(song.plays(0, 'a')).toBe(false);
        expect(song.plays(1, 'a')).toBe(true);
        expect(song.plays(7, 'a')).toBe(false);
        expect(song.isEmpty).toBe(false);

        song.toggle(1, 'a');
        expect(song.plays(1, 'a')).toBe(false);
    });

    it('fills and clears a whole row', () => {
        const song = new Song(3);
        song.setPlaysEverywhere('a', true);
        expect(song.countSections('a')).toBe(3);

        song.setPlaysEverywhere('a', false);
        expect(song.countSections('a')).toBe(0);
    });

    it('adds, duplicates, moves and removes sections', () => {
        const song = new Song(1);
        const [first] = song.sections;
        song.setPlays(0, 'a', true);

        const copy = song.duplicateSection(first!.id)!;
        expect(song.length).toBe(2);
        expect(song.plays(1, 'a')).toBe(true);
        expect(copy.trackIds).not.toBe(first!.trackIds);

        const added = song.addSection(0);
        expect(song.sections[0]).toBe(added);
        expect(song.plays(0, 'a')).toBe(false);

        song.moveSection(added.id, 1);
        expect(song.sections[1]).toBe(added);
        song.moveSection(added.id, -1);
        song.moveSection(added.id, -1);
        expect(song.sections[0]).toBe(added);

        song.removeSection(added.id);
        song.removeSection(copy.id);
        expect(song.sections).toEqual([first]);

        song.removeSection(first!.id);
        expect(song.length).toBe(1);
    });

    it('forgets deleted tracks and copies duplicated ones', () => {
        const song = new Song(2);
        song.setPlays(1, 'a', true);

        song.copyTrack('a', 'b');
        expect(song.plays(1, 'b')).toBe(true);
        expect(song.plays(0, 'b')).toBe(false);

        song.removeTrack('a');
        expect(song.countSections('a')).toBe(0);
        expect(song.countSections('b')).toBe(1);
    });
});
