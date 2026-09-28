/**
 * What the sample browser shows of a folder: the audio files the browser can decode, and the folders around them.
 * Pure helpers, no DOM access, so they can be tested on their own.
 */

/** Extensions of audio files `decodeAudioData` handles in at least the common browsers. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['wav', 'wave', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'm4a', 'aac', 'mp4', 'webm', 'caf']);

const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** True for a file name the browser shows: an audio file that is not hidden (macOS leaves `._kick.wav` twins around). */
export const isAudioFileName = (name: string): boolean => !name.startsWith('.') && AUDIO_EXTENSIONS.has(extensionOf(name));

/** Hidden folders (`.git`, `.Trash`) stay out of the tree. */
export const isVisibleFolderName = (name: string): boolean => !!name && !name.startsWith('.');

/** A file name without its extension: what a new track or container is called. */
export const sampleBaseName = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return (dot > 0 ? name.slice(0, dot) : name).trim() || name;
};

/** The longest a file or folder name shows in the browser, in characters; the full name is in its tooltip. */
export const MAX_NAME_LENGTH = 28;

/**
 * Shortens a name to `max` characters with an ellipsis. A file keeps its extension in view (`a very long nam….wav`),
 * so samples that only differ in their type still tell apart; a folder's dots are just part of its name.
 */
export const truncateName = (name: string, kind: 'folder' | 'file' = 'file', max = MAX_NAME_LENGTH): string => {
    if (name.length <= max) {
        return name;
    }
    const dot = name.lastIndexOf('.');
    const extension = kind === 'file' && dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
    const keep = Math.max(1, max - extension.length - 1);
    return `${name.slice(0, keep).trimEnd()}…${extension}`;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then by name the way a file manager sorts: `kick 2` before `kick 10`. */
export const compareEntries = (a: { name: string; kind: 'folder' | 'file' }, b: { name: string; kind: 'folder' | 'file' }): number => {
    if (a.kind !== b.kind) {
        return a.kind === 'folder' ? -1 : 1;
    }
    return collator.compare(a.name, b.name);
};

/** A folder read from a file list (`<input webkitdirectory>`), where the browser hands out every file at once. */
export interface FileTreeFolder<F = File> {
    name: string;
    folders: FileTreeFolder<F>[];
    files: F[];
}

/** The part of `File` the tree needs; `webkitRelativePath` is `root/sub/file.wav`. */
export type RelativeFile = Pick<File, 'name' | 'webkitRelativePath'>;

/**
 * Builds the folder tree of a picked directory from its flat file list, keeping only audio files (and so only
 * folders that hold some, somewhere below). Returns null when the list holds no audio at all.
 */
export const buildFileTree = <F extends RelativeFile>(files: Iterable<F>): FileTreeFolder<F> | null => {
    let root: FileTreeFolder<F> | null = null;

    for (const file of files) {
        const parts = (file.webkitRelativePath || file.name).split('/').filter(Boolean);
        const fileName = parts.pop();
        // The picked folder itself may be hidden; the user chose it.
        const [rootName = '', ...path] = parts;
        if (!fileName || !isAudioFileName(fileName) || path.some((part) => !isVisibleFolderName(part))) {
            continue;
        }
        root ??= { name: rootName, folders: [], files: [] };

        let folder = root;
        for (const name of path) {
            let next = folder.folders.find((candidate) => candidate.name === name);
            if (!next) {
                next = { name, folders: [], files: [] };
                folder.folders.push(next);
            }
            folder = next;
        }
        folder.files.push(file);
    }

    if (root) {
        sortTree(root);
    }
    return root;
};

const sortTree = <F extends RelativeFile>(folder: FileTreeFolder<F>): void => {
    folder.folders.sort((a, b) => collator.compare(a.name, b.name));
    folder.files.sort((a, b) => collator.compare(a.name, b.name));
    folder.folders.forEach(sortTree);
};
