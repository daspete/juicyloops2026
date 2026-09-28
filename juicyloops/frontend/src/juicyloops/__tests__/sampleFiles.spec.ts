import { describe, expect, it } from 'vitest';
import { buildFileTree, compareEntries, isAudioFileName, isVisibleFolderName, sampleBaseName, truncateName } from '../sampleFiles';

const file = (webkitRelativePath: string) => ({ name: webkitRelativePath.split('/').pop()!, webkitRelativePath });

describe('sample files', () => {
    it('knows audio files by their extension, in any case', () => {
        expect(isAudioFileName('kick.wav')).toBe(true);
        expect(isAudioFileName('Loop 01.AIFF')).toBe(true);
        expect(isAudioFileName('pad.flac')).toBe(true);
        expect(isAudioFileName('readme.txt')).toBe(false);
        expect(isAudioFileName('wav')).toBe(false);
        expect(isAudioFileName('._kick.wav')).toBe(false);
    });

    it('hides hidden folders', () => {
        expect(isVisibleFolderName('Drums')).toBe(true);
        expect(isVisibleFolderName('.git')).toBe(false);
        expect(isVisibleFolderName('')).toBe(false);
    });

    it('names a sample without its extension', () => {
        expect(sampleBaseName('Kick 01.wav')).toBe('Kick 01');
        expect(sampleBaseName('snare.final.mp3')).toBe('snare.final');
        expect(sampleBaseName('.wav')).toBe('.wav');
    });

    it('shortens long file names but keeps the extension', () => {
        expect(truncateName('kick.wav', 'file', 12)).toBe('kick.wav');
        expect(truncateName('a very long sample name.wav', 'file', 16)).toBe('a very long….wav');
        expect(truncateName('a very long sample name.wav', 'file', 16)).toHaveLength(16);
        expect(truncateName('no extension at all here', 'file', 10)).toBe('no extens…');
    });

    it('shortens long folder names from the end, dots and all', () => {
        expect(truncateName('Drums', 'folder', 10)).toBe('Drums');
        expect(truncateName('Vintage Drum Pack.v2', 'folder', 12)).toBe('Vintage Dru…');
    });

    it('sorts folders first, then numbers the way people read them', () => {
        const entries = [
            { name: 'kick 10.wav', kind: 'file' as const },
            { name: 'Snares', kind: 'folder' as const },
            { name: 'kick 2.wav', kind: 'file' as const },
            { name: 'bass', kind: 'folder' as const },
        ];
        expect(entries.sort(compareEntries).map((entry) => entry.name)).toEqual(['bass', 'Snares', 'kick 2.wav', 'kick 10.wav']);
    });

    it('builds a sorted tree of the audio files of a picked folder', () => {
        const tree = buildFileTree([
            file('Pack/Drums/snare 10.wav'),
            file('Pack/Drums/snare 2.wav'),
            file('Pack/notes.txt'),
            file('Pack/Bass/sub.mp3'),
            file('Pack/Docs/manual.pdf'),
            file('Pack/.hidden/secret.wav'),
            file('Pack/intro.ogg'),
        ]);

        expect(tree?.name).toBe('Pack');
        expect(tree?.files.map((f) => f.name)).toEqual(['intro.ogg']);
        expect(tree?.folders.map((folder) => folder.name)).toEqual(['Bass', 'Drums']);
        expect(tree?.folders[1]!.files.map((f) => f.name)).toEqual(['snare 2.wav', 'snare 10.wav']);
    });

    it('has no tree for a folder without audio', () => {
        expect(buildFileTree([file('Docs/readme.txt')])).toBeNull();
        expect(buildFileTree([])).toBeNull();
    });
});
