/**
 * Pure bookkeeping for notes played live on a track (MIDI): the sustain pedal and last-note priority. The tracks
 * use these and do the sound themselves; nothing here knows about audio.
 */

/** How a key sounds: held down, or only by the sustain pedal (its key is up). */
export type HeldKey = 'held' | 'sustained';

/** The keys that sound on a track, by note name ('C4'). */
export type HeldKeys = ReadonlyMap<string, HeldKey>;

export const NO_HELD_KEYS: HeldKeys = new Map();

/**
 * The sustain pedal of one track. Note-offs that arrive while the pedal is down are held back and released when it
 * comes up. A key struck again while its note still rings (held by the pedal) restarts it: the caller stops the old
 * voice first.
 */
export class SustainGate {
    /** Every live note that sounds, held by its key or by the pedal, with its note name. */
    private readonly sounding = new Map<string, string>();
    /** The notes whose key came up while the pedal was down. */
    private readonly deferred = new Set<string>();
    private down = false;

    get isDown(): boolean {
        return this.down;
    }

    /** How many live notes sound. */
    get size(): number {
        return this.sounding.size;
    }

    has(id: string): boolean {
        return this.sounding.has(id);
    }

    /** A key went down. True when the same note still sounds (the caller stops that voice before starting the new one). */
    press(id: string, note = ''): boolean {
        const restrike = this.sounding.has(id);
        this.sounding.set(id, note);
        this.deferred.delete(id);
        return restrike;
    }

    /** A key came up. True when the note stops now; false when it was not sounding or the pedal holds it. */
    release(id: string): boolean {
        if (!this.sounding.has(id)) {
            return false;
        }
        if (this.down) {
            this.deferred.add(id);
            return false;
        }
        this.sounding.delete(id);
        return true;
    }

    /** The pedal went down or up. Returns the notes that stop now (those whose key came up while it was down). */
    pedal(down: boolean): string[] {
        this.down = down;
        if (down || !this.deferred.size) {
            return [];
        }
        const released = [...this.deferred];
        for (const id of released) {
            this.sounding.delete(id);
        }
        this.deferred.clear();
        return released;
    }

    /** Forgets everything (all notes off); returns every note that was sounding. The pedal state stays. */
    clear(): string[] {
        const all = [...this.sounding.keys()];
        this.sounding.clear();
        this.deferred.clear();
        return all;
    }

    /**
     * The keys that sound, by note name: 'held' while a key plays it, else 'sustained' (the pedal holds it). Two ids
     * with the same name (two inputs) count once, 'held' first. A new map on every call; empty is `NO_HELD_KEYS`.
     */
    keys(): HeldKeys {
        if (!this.sounding.size) {
            return NO_HELD_KEYS;
        }
        const keys = new Map<string, HeldKey>();
        for (const [id, note] of this.sounding) {
            if (!note) {
                continue;
            }
            if (!this.deferred.has(id)) {
                keys.set(note, 'held');
            } else if (!keys.has(note)) {
                keys.set(note, 'sustained');
            }
        }
        return keys;
    }
}

export interface HeldNote<T> {
    id: string;
    value: T;
}

/**
 * Last-note priority for a track that plays one note at a time (cut mode): the newest key wins, and when the key
 * that sounds comes up while others are still held, the newest of those takes over again.
 */
export class NoteStack<T> {
    private readonly held: HeldNote<T>[] = [];

    get size(): number {
        return this.held.length;
    }

    /** The note that sounds: the newest held one. */
    get current(): HeldNote<T> | undefined {
        return this.held[this.held.length - 1];
    }

    press(id: string, value: T): void {
        this.remove(id);
        this.held.push({ id, value });
    }

    /**
     * A note stops. Returns what sounds next: `undefined` when the note was not the one sounding (nothing changes),
     * `null` when it was and nothing else is held (silence), or the held note that takes over.
     */
    release(id: string): HeldNote<T> | null | undefined {
        const wasCurrent = this.current?.id === id;
        if (!this.remove(id) || !wasCurrent) {
            return undefined;
        }
        return this.current ?? null;
    }

    clear(): void {
        this.held.length = 0;
    }

    private remove(id: string): boolean {
        const index = this.held.findIndex((note) => note.id === id);
        if (index === -1) {
            return false;
        }
        this.held.splice(index, 1);
        return true;
    }
}
