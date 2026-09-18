import { computed, ref } from 'vue';
import { engine } from '@/juicyloops/engine';
import { packSession, SESSION_FILE_EXTENSION, SESSION_FILE_MIME, SessionFileError, sessionFileName, sessionNameOf, unpackSession, type SavedSession } from '@/juicyloops/sessionFile';
import { downloadBlob } from './download';
import { useHistory } from './useHistory';
import { useJuicyLoops } from './useJuicyLoops';

/**
 * Saving and opening the session as a file. The file holds everything: containers, tracks, patterns, effects,
 * automation, the song, the tempo, and the audio of every sample and microphone recording.
 *
 * Where the browser offers the File System Access API (Chromium), the file is picked once and every later save
 * writes to it again, like a desktop app. Elsewhere a save downloads the file and open asks for one.
 *
 * Module level state: there is one session.
 */

export const DEFAULT_SESSION_NAME = 'Untitled loop';

/* The pickers are not in TypeScript's DOM library yet. */
interface FilePickerType {
    description: string;
    accept: Record<string, string[]>;
}
interface FilePickerOptions {
    suggestedName?: string;
    types?: FilePickerType[];
    excludeAcceptAllOption?: boolean;
    id?: string;
}
interface PickerWindow {
    showSaveFilePicker?: (options?: FilePickerOptions) => Promise<FileSystemFileHandle>;
    showOpenFilePicker?: (options?: FilePickerOptions & { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
}

const FILE_TYPES: FilePickerType[] = [{ description: 'JuicyLoops session', accept: { [SESSION_FILE_MIME]: [SESSION_FILE_EXTENSION] } }];
const PICKER_ID = 'juicyloops-session';

const pickers = (): PickerWindow => (typeof window === 'undefined' ? {} : (window as unknown as PickerWindow));
const isCancel = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

const { bpm, setBpm, stop, selectContainer } = useJuicyLoops();
const { commit, reset, revision } = useHistory();

const name = ref(DEFAULT_SESSION_NAME);
/** True while a file is being written or read. */
const isBusy = ref(false);
/** The history revision the file on disk (or the last download) has. */
const savedRevision = ref(revision.value);
const isDirty = computed(() => revision.value !== savedRevision.value);

/** The file the session was opened from or last saved to, when the browser can hand one out. */
let handle: FileSystemFileHandle | null = null;
const hasFile = ref(false);

const setName = (value: string): void => {
    const trimmed = value.trim();
    name.value = trimmed || DEFAULT_SESSION_NAME;
};

const setHandle = (next: FileSystemFileHandle | null): void => {
    handle = next;
    hasFile.value = next !== null;
};

const capture = (): SavedSession => ({ name: name.value, bpm: bpm.value, session: engine.capture() });

/** What went wrong, in the words a person needs. */
const describe = (error: unknown, fallback: string): string => {
    if (error instanceof SessionFileError) {
        return error.message;
    }
    console.error(fallback, error);
    return fallback;
};

export type SessionResult = { ok: true; fileName: string } | { ok: false; error: string } | { ok: false; cancelled: true };

/**
 * Writes the session to its file. `as` (or no file yet) asks where to put it. On browsers without the picker
 * the file is downloaded instead. The name follows the file that was picked.
 */
const save = async (options: { as?: boolean } = {}): Promise<SessionResult> => {
    if (isBusy.value) {
        return { ok: false, cancelled: true };
    }
    isBusy.value = true;
    try {
        commit();
        const { showSaveFilePicker } = pickers();
        if (showSaveFilePicker) {
            if (!handle || options.as) {
                setHandle(await showSaveFilePicker({ suggestedName: sessionFileName(name.value), types: FILE_TYPES, id: PICKER_ID }));
                setName(sessionNameOf(handle!.name));
            }
            const blob = packSession(capture());
            const writable = await handle!.createWritable();
            await writable.write(blob);
            await writable.close();
        } else {
            downloadBlob(packSession(capture()), sessionFileName(name.value));
        }
        savedRevision.value = revision.value;
        return { ok: true, fileName: handle?.name ?? sessionFileName(name.value) };
    } catch (error) {
        if (isCancel(error)) {
            return { ok: false, cancelled: true };
        }
        return { ok: false, error: describe(error, 'The file could not be written.') };
    } finally {
        isBusy.value = false;
    }
};

/** Takes a loaded session over: playback stops, the state is applied, the samples decode, history starts afresh. */
const apply = async (saved: SavedSession): Promise<void> => {
    stop();
    await engine.load(saved.session);
    setBpm(saved.bpm);
    selectContainer(saved.session.currentContainerId);
    reset();
    savedRevision.value = revision.value;
};

/** Opens a file the user handed over (from a picker, an input or a drop). */
const openFile = async (file: File, fileHandle: FileSystemFileHandle | null = null): Promise<SessionResult> => {
    if (isBusy.value) {
        return { ok: false, cancelled: true };
    }
    isBusy.value = true;
    try {
        const saved = unpackSession(await file.arrayBuffer());
        await apply(saved);
        setName(saved.name || sessionNameOf(file.name));
        setHandle(fileHandle);
        return { ok: true, fileName: file.name };
    } catch (error) {
        return { ok: false, error: describe(error, 'The file could not be opened.') };
    } finally {
        isBusy.value = false;
    }
};

/** Asks for a file with the browser's file input, for browsers without the picker. */
const askForFile = (): Promise<File | null> =>
    new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = SESSION_FILE_EXTENSION;
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
        input.addEventListener('cancel', () => resolve(null));
        input.click();
    });

/** Asks for a file and opens it. The session it replaces is gone unless it was saved. */
const open = async (): Promise<SessionResult> => {
    if (isBusy.value) {
        return { ok: false, cancelled: true };
    }
    try {
        const { showOpenFilePicker } = pickers();
        if (showOpenFilePicker) {
            const [picked] = await showOpenFilePicker({ types: FILE_TYPES, multiple: false, id: PICKER_ID });
            return picked ? openFile(await picked.getFile(), picked) : { ok: false, cancelled: true };
        }
        const file = await askForFile();
        return file ? openFile(file) : { ok: false, cancelled: true };
    } catch (error) {
        if (isCancel(error)) {
            return { ok: false, cancelled: true };
        }
        return { ok: false, error: describe(error, 'The file could not be opened.') };
    }
};

/** Whether a file (from a drop) looks like a session file. */
const isSessionFile = (file: File): boolean => file.name.toLowerCase().endsWith(SESSION_FILE_EXTENSION) || file.type === SESSION_FILE_MIME;

export const useSession = () => ({ name, setName, isBusy, isDirty, hasFile, save, open, openFile, isSessionFile });
