import { computed, markRaw, reactive, ref } from 'vue';
import { createId } from '@/juicyloops/ids';
import { buildFileTree, compareEntries, isAudioFileName, isVisibleFolderName, sampleBaseName, type FileTreeFolder } from '@/juicyloops/sampleFiles';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import type { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { deleteFolder, loadFolders, saveFolder } from './sampleFolderStore';
import { useJuicyLoops } from './useJuicyLoops';
import { useWorkspace } from './useWorkspace';

/**
 * The sample browser: folders of the user's disk, shown as trees, whose audio files can be auditioned and dropped
 * into a container as sampler tracks.
 *
 * Where the browser has the File System Access API (Chromium), a folder is a directory handle: it is read lazily,
 * one level when it opens, and it is remembered for the next visit (reading it again then needs one click to allow
 * access). Elsewhere a folder comes from `<input webkitdirectory>`, which hands out every file at once and lasts
 * for this visit only.
 *
 * Module level state: there is one browser.
 */

/* The parts of the File System Access API that TypeScript's DOM library does not know yet. */
type Permission = 'granted' | 'denied' | 'prompt';
interface ReadableDirectory extends FileSystemDirectoryHandle {
    queryPermission?(descriptor: { mode: 'read' }): Promise<Permission>;
    requestPermission?(descriptor: { mode: 'read' }): Promise<Permission>;
}
interface PickerWindow {
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}

/** Where a node's content comes from. Held raw: a native handle behind Vue's proxy throws "Illegal invocation". */
type NodeSource =
    | { kind: 'directory'; handle: ReadableDirectory }
    | { kind: 'file-handle'; handle: FileSystemFileHandle }
    | { kind: 'folder'; folder: FileTreeFolder }
    | { kind: 'file'; file: File };

export interface BrowserNode {
    /** Unique in the browser: the root's key and the path below it. */
    id: string;
    name: string;
    kind: 'folder' | 'file';
    depth: number;
    parentId: string | null;
    /** A folder's entries, null until it was read. */
    children: BrowserNode[] | null;
    isExpanded: boolean;
    isLoading: boolean;
    error: string | null;
    source: NodeSource;
}

export interface BrowserRoot extends BrowserNode {
    /** Whether the folder can be read right now; a remembered folder needs the user's permission again on a new visit. */
    access: Permission;
    /** Remembered for the next visit (a directory handle), or only for this one (a picked file list). */
    isPersistent: boolean;
}

const PICKER_ID = 'juicyloops-samples';

const roots = reactive<BrowserRoot[]>([]);
const isRestored = ref(false);
let restoring: Promise<void> | null = null;

const pickerWindow = (): PickerWindow => (typeof window === 'undefined' ? {} : (window as unknown as PickerWindow));
/** Folders can be picked as handles, and remembered. */
const canPickDirectories = typeof window !== 'undefined' && typeof pickerWindow().showDirectoryPicker === 'function';

const isCancel = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';
const isPermissionError = (error: unknown): boolean => error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const makeNode = (parent: BrowserNode | null, name: string, kind: BrowserNode['kind'], source: NodeSource, id?: string): BrowserNode => ({
    id: id ?? `${parent!.id}/${name}`,
    name,
    kind,
    depth: parent ? parent.depth + 1 : 0,
    parentId: parent?.id ?? null,
    children: null,
    isExpanded: false,
    isLoading: false,
    error: null,
    source: markRaw(source),
});

const makeRoot = (name: string, source: NodeSource, key: string, access: Permission, isPersistent: boolean): BrowserRoot => ({
    ...makeNode(null, name, 'folder', source, key),
    access,
    isPersistent,
});

/** Every node by id, for the keyboard and the menus. */
const findNode = (id: string): BrowserNode | undefined => {
    const walk = (nodes: readonly BrowserNode[]): BrowserNode | undefined => {
        for (const node of nodes) {
            if (node.id === id) {
                return node;
            }
            const found = node.children && id.startsWith(`${node.id}/`) ? walk(node.children) : undefined;
            if (found) {
                return found;
            }
        }
        return undefined;
    };
    return walk(roots);
};

const rootOf = (node: BrowserNode): BrowserRoot | undefined => roots.find((root) => node.id === root.id || node.id.startsWith(`${root.id}/`));

/* ---- reading folders ---- */

const readEntries = async (node: BrowserNode): Promise<BrowserNode[]> => {
    const source = node.source;
    if (source.kind === 'folder') {
        return [
            ...source.folder.folders.map((folder) => makeNode(node, folder.name, 'folder', { kind: 'folder', folder })),
            ...source.folder.files.map((file) => makeNode(node, file.name, 'file', { kind: 'file', file })),
        ];
    }
    if (source.kind !== 'directory') {
        return [];
    }

    const entries: BrowserNode[] = [];
    for await (const handle of source.handle.values()) {
        if (handle.kind === 'directory' && isVisibleFolderName(handle.name)) {
            entries.push(makeNode(node, handle.name, 'folder', { kind: 'directory', handle: handle as ReadableDirectory }));
        } else if (handle.kind === 'file' && isAudioFileName(handle.name)) {
            entries.push(makeNode(node, handle.name, 'file', { kind: 'file-handle', handle: handle as FileSystemFileHandle }));
        }
    }
    return entries.sort(compareEntries);
};

/** Reads a folder's entries (again, with `force`). */
const load = async (node: BrowserNode, force = false): Promise<void> => {
    if (node.kind !== 'folder' || node.isLoading || (node.children && !force)) {
        return;
    }
    const root = rootOf(node);
    if (root && root.access !== 'granted') {
        return;
    }

    node.isLoading = true;
    node.error = null;
    try {
        const entries = await readEntries(node);
        if (force && node.children) {
            // Folders that were open stay open, with their entries read again.
            const open = new Set(node.children.filter((child) => child.isExpanded).map((child) => child.id));
            node.children = entries;
            await Promise.all(
                node.children
                    .filter((child) => open.has(child.id))
                    .map((child) => {
                        child.isExpanded = true;
                        return load(child);
                    }),
            );
        } else {
            node.children = entries;
        }
    } catch (error) {
        if (root && isPermissionError(error)) {
            root.access = 'prompt';
            root.isExpanded = false;
        } else {
            node.error = describe(error);
        }
    } finally {
        node.isLoading = false;
    }
};

const setExpanded = async (node: BrowserNode, expanded: boolean): Promise<void> => {
    if (node.kind !== 'folder') {
        return;
    }
    node.isExpanded = expanded;
    if (expanded) {
        await load(node);
    }
};

const toggleExpanded = (node: BrowserNode): Promise<void> => setExpanded(node, !node.isExpanded);

/** Asks for permission to read a remembered folder again; the browser only asks in answer to a click. */
const requestAccess = async (root: BrowserRoot): Promise<boolean> => {
    if (root.source.kind !== 'directory') {
        return root.access === 'granted';
    }
    try {
        root.access = (await root.source.handle.requestPermission?.({ mode: 'read' })) ?? 'granted';
    } catch {
        root.access = 'denied';
    }
    if (root.access === 'granted') {
        await setExpanded(root, true);
    }
    return root.access === 'granted';
};

/** Brings back the folders of the last visit. Runs once; the browser panel calls it when it first opens. */
const restore = (): Promise<void> => {
    restoring ??= (async () => {
        if (!canPickDirectories) {
            isRestored.value = true;
            return;
        }
        for (const stored of await loadFolders()) {
            if (roots.some((root) => root.id === stored.key)) {
                continue;
            }
            const handle = stored.handle as ReadableDirectory;
            let access: Permission = 'prompt';
            try {
                access = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
            } catch {
                /* keeps asking */
            }
            roots.push(makeRoot(stored.name, { kind: 'directory', handle }, stored.key, access, true));
        }
        isRestored.value = true;
    })();
    return restoring;
};

/* ---- adding and removing folders ---- */

export type AddFolderResult = { ok: true; root: BrowserRoot; isNew: boolean } | { ok: false; reason: 'cancelled' | 'unsupported' | 'empty' | 'error'; error?: string };

const addRoot = async (root: BrowserRoot): Promise<BrowserRoot> => {
    roots.push(root);
    // The array hands out the reactive node, which the UI then sees loading.
    const added = roots[roots.length - 1]!;
    await setExpanded(added, true);
    return added;
};

/** Picks a folder with the system dialog and adds it (or finds it, when it is there already). Chromium only. */
const pickFolder = async (): Promise<AddFolderResult> => {
    const { showDirectoryPicker } = pickerWindow();
    if (!showDirectoryPicker) {
        return { ok: false, reason: 'unsupported' };
    }
    let handle: ReadableDirectory;
    try {
        handle = (await showDirectoryPicker({ id: PICKER_ID, mode: 'read' })) as ReadableDirectory;
    } catch (error) {
        return isCancel(error) ? { ok: false, reason: 'cancelled' } : { ok: false, reason: 'error', error: describe(error) };
    }

    for (const root of roots) {
        if (root.source.kind === 'directory' && (await root.source.handle.isSameEntry(handle))) {
            if (root.access !== 'granted') {
                await requestAccess(root);
            } else {
                await setExpanded(root, true);
            }
            return { ok: true, root, isNew: false };
        }
    }

    const key = createId();
    void saveFolder({ key, name: handle.name, handle, addedAt: Date.now() });
    return { ok: true, root: await addRoot(makeRoot(handle.name, { kind: 'directory', handle }, key, 'granted', true)), isNew: true };
};

/** Adds a folder picked with `<input webkitdirectory>`: its whole file list at once, for this visit only. */
const addFileList = async (files: FileList | File[]): Promise<AddFolderResult> => {
    const tree = buildFileTree(Array.from(files));
    if (!tree) {
        return { ok: false, reason: 'empty' };
    }
    return { ok: true, root: await addRoot(makeRoot(tree.name || 'Samples', { kind: 'folder', folder: tree }, createId(), 'granted', false)), isNew: true };
};

const removeRoot = (id: string): void => {
    const index = roots.findIndex((root) => root.id === id);
    if (index !== -1) {
        roots.splice(index, 1);
        void deleteFolder(id);
    }
};

/* ---- the tree as rows ---- */

/** Every node that shows, in order: the roots, and below every open folder its entries. */
const rows = computed<BrowserNode[]>(() => {
    const list: BrowserNode[] = [];
    const walk = (nodes: readonly BrowserNode[]) => {
        for (const node of nodes) {
            list.push(node);
            if (node.isExpanded && node.children) {
                walk(node.children);
            }
        }
    };
    walk(roots);
    return list;
});

/* ---- files ---- */

/** The file behind a sample node; a handle reads its current state from disk. */
const fileOf = async (node: BrowserNode): Promise<File> => {
    const source = node.source;
    if (source.kind === 'file') {
        return source.file;
    }
    if (source.kind === 'file-handle') {
        try {
            return await source.handle.getFile();
        } catch (error) {
            const root = rootOf(node);
            if (root && isPermissionError(error)) {
                root.access = 'prompt';
            }
            throw error;
        }
    }
    throw new Error(`${node.name} is a folder`);
};

/* ---- into the song ---- */

const { currentContainer, addContainer, renameContainer, addTrack, removeTrack } = useJuicyLoops();
const { selectTrack } = useWorkspace();

export type AddSampleTarget = 'current' | 'new';

/**
 * Adds a sampler track playing the sample, to the current container or to a new one named after the sample (which
 * then becomes the current container). Resolves with the container once the sample is decoded.
 */
const addToContainer = async (node: BrowserNode, target: AddSampleTarget): Promise<TrackContainer> => {
    const file = await fileOf(node);
    if (target === 'new') {
        const created = addContainer();
        renameContainer(created.id, sampleBaseName(file.name));
    }
    // Through the reactive container, so the track the UI renders is the one that gets the sample.
    const container = currentContainer.value;
    const { id } = addTrack('sampler', container);
    const track = container.tracks.find((candidate): candidate is SamplerTrack => candidate.id === id && candidate.type === 'sampler');
    if (!track) {
        throw new Error('The track could not be added');
    }
    selectTrack(track.id);
    try {
        await track.setFile(file);
    } catch (error) {
        // An undecodable file leaves no empty track behind.
        removeTrack(track.id, container);
        throw error;
    }
    return container;
};

export const useSampleBrowser = () => ({
    roots,
    rows,
    isRestored,
    canPickDirectories,
    restore,
    pickFolder,
    addFileList,
    removeRoot,
    requestAccess,
    findNode,
    rootOf,
    load,
    setExpanded,
    toggleExpanded,
    fileOf,
    addToContainer,
});
