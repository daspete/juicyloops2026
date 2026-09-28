import { shallowReactive } from 'vue';
import { NO_HELD_KEYS, type HeldKeys } from './liveNotes';

/**
 * The keys MIDI holds on each track right now, for the piano roll's key lighting. Written by the tracks (`BaseTrack`)
 * on every live note-on, note-off, pedal change and all-notes-off; never per frame, never for scheduled pattern notes.
 *
 * Reactive per track: the store is a shallow reactive Map keyed by track id, so reading `heldKeysOf(id)` in a
 * component depends on that track's entry only, and each entry is a plain, frozen-by-convention map that is replaced,
 * never mutated. A track with nothing held has no entry.
 */
const store = shallowReactive(new Map<string, HeldKeys>());

/** The keys held on a track (note name → 'held' | 'sustained'); empty when none. */
export const heldKeysOf = (trackId: string): HeldKeys => store.get(trackId) ?? NO_HELD_KEYS;

const sameKeys = (a: HeldKeys, b: HeldKeys): boolean => {
    if (a.size !== b.size) {
        return false;
    }
    for (const [note, state] of a) {
        if (b.get(note) !== state) {
            return false;
        }
    }
    return true;
};

/** Sets what a track holds now. Changes nothing (and wakes no reader) when it is what the track held before. */
export const publishHeldKeys = (trackId: string, keys: HeldKeys): void => {
    const before = store.get(trackId);
    if (!keys.size) {
        if (before) {
            store.delete(trackId);
        }
        return;
    }
    if (!before || !sameKeys(before, keys)) {
        store.set(trackId, keys);
    }
};
