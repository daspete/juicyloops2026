import { computed, ref } from 'vue';
import { engine } from '@/juicyloops/engine';
import type { SessionState } from '@/juicyloops/sequencer';
import { useJuicyLoops } from './useJuicyLoops';

/**
 * Undo and redo for the whole session, the way a DAW does it: every step is a snapshot of everything
 * the user can change (tracks, patterns, effects, automation, containers, the song, tempo).
 *
 * Nothing needs to announce a change. `commit` is called after every user gesture (the app shell wires it to
 * pointer, key and change events, plus a watcher for changes that land later); it captures the session and only
 * keeps the snapshot when something actually differs from the last one. Snapshots are small: patterns and
 * parameters are numbers, and a sample is kept by reference, never copied.
 */
interface Entry {
    state: SessionState & { bpm: number };
    /** The state as a string, to tell snapshots apart. */
    key: string;
}

const MAX_ENTRIES = 200;

const { bpm, setBpm, selectContainer } = useJuicyLoops();

/* Blobs cannot be stringified; every one gets a number instead, so two snapshots of the same sample compare equal. */
const blobIds = new WeakMap<Blob, number>();
let nextBlobId = 1;
const replacer = (_key: string, value: unknown) => {
    if (value instanceof Blob) {
        if (!blobIds.has(value)) {
            blobIds.set(value, nextBlobId++);
        }
        return `blob#${blobIds.get(value)}`;
    }
    return value;
};

const capture = (): Entry => {
    const state = { ...engine.capture(), bpm: bpm.value };
    return { state, key: JSON.stringify(state, replacer) };
};

const undoStack = ref<Entry[]>([]);
const redoStack = ref<Entry[]>([]);
let current: Entry = capture();

/** Bumped after every undo or redo, so views that keep their own copy of a value (knobs) read it again. */
const version = ref(0);

/** Bumped whenever the session changes (a commit that kept something, an undo, a redo, a reset): what "unsaved changes" is measured against. */
const revision = ref(0);

const canUndo = computed(() => undoStack.value.length > 0);
const canRedo = computed(() => redoStack.value.length > 0);

/** Records the session as one undo step, if it changed since the last one. Safe to call as often as you like. */
const commit = (): boolean => {
    const next = capture();
    if (next.key === current.key) {
        return false;
    }
    undoStack.value.push(current);
    if (undoStack.value.length > MAX_ENTRIES) {
        undoStack.value.shift();
    }
    redoStack.value = [];
    current = next;
    revision.value++;
    return true;
};

const apply = (entry: Entry) => {
    current = entry;
    engine.restore(entry.state);
    setBpm(entry.state.bpm);
    selectContainer(entry.state.currentContainerId);
    version.value++;
    revision.value++;
};

const undo = (): void => {
    // Whatever happened since the last commit is a step of its own, so it can be redone.
    commit();
    const entry = undoStack.value.pop();
    if (entry) {
        redoStack.value.push(current);
        apply(entry);
    }
};

const redo = (): void => {
    const entry = redoStack.value.pop();
    if (entry) {
        undoStack.value.push(current);
        apply(entry);
    }
};

/** Forgets the history and starts again from the session as it is now (after a file was opened). */
const reset = (): void => {
    undoStack.value = [];
    redoStack.value = [];
    current = capture();
    version.value++;
    revision.value++;
};

export const useHistory = () => ({ canUndo, canRedo, commit, undo, redo, reset, version, revision });
