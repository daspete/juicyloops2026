import { MIN_NOTE_LENGTH, stepOfStart, type NoteInput, type PatternNote } from '../notes/Note';

/**
 * One take: what the recorder writes while recording runs. Pure bookkeeping over running steps (fractional, as the
 * transport counts them); where a step lands in a pattern is the caller's `position` function (`recordTiming.ts`).
 *
 * - A note-on opens a note on every track it was played on, at the pattern position of its step. When that track is
 *   not playing at that step (`position` gives null), nothing opens: the note was heard, not recorded.
 * - The note-off closes it with the length it was held, measured in running steps, so a note held across the loop
 *   end keeps its full length and its tail rings across the wrap. While that track's sustain pedal is down, the
 *   note closes at the pedal-up instead (the same rule the tracks play by, `SustainGate`).
 * - The same key again while its note is open (a restrike under the pedal) closes the old note where the new starts.
 * - `stop` closes every open note at the stop.
 * - A note is added to its track the moment it closes, so it shows up while recording goes on.
 *
 * Timings are kept as played, never quantized.
 */

/** What a take writes into. `BaseTrack` is one (through its reactive proxy, so the views see the notes arrive). */
export interface TakeTrack {
    readonly id: string;
    addNote(input: NoteInput): PatternNote;
}

export interface TakeOptions {
    track(id: string): TakeTrack | undefined;
    /** Where a running step lands in a track's pattern, or null when the track is not playing there. */
    position(trackId: string, step: number): number | null;
    /** Tracks whose sustain pedal is already down when the take starts. */
    pedalDown?: Iterable<string>;
}

interface OpenNote {
    trackId: string;
    liveId: string;
    note: string;
    velocity: number;
    /** The running step it started at. */
    step: number;
    /** Where in the pattern it starts. */
    position: number;
    /** The key came up while the pedal was down: it closes at the pedal-up. */
    released: boolean;
}

const keyOf = (trackId: string, liveId: string): string => `${trackId}\u0000${liveId}`;

export class Take {
    /** Every pattern note this take added, by id. */
    readonly noteIds = new Set<string>();
    /** The notes this take added, in the order they closed (for tests and the UI). */
    readonly notes: { trackId: string; note: PatternNote }[] = [];

    private readonly open = new Map<string, OpenNote>();
    private readonly pedal = new Set<string>();

    constructor(private readonly options: TakeOptions) {
        for (const id of options.pedalDown ?? []) {
            this.pedal.add(id);
        }
    }

    /** How many notes are held open (their keys or the pedal). */
    get openCount(): number {
        return this.open.size;
    }

    /** A key went down at running step `step` (null: outside the take, nothing is recorded) on these tracks. */
    noteOn(liveId: string, note: string, velocity: number, trackIds: readonly string[], step: number | null): void {
        for (const trackId of trackIds) {
            const key = keyOf(trackId, liveId);
            const previous = this.open.get(key);
            if (previous && step !== null) {
                this.close(key, previous, step);
            } else if (previous) {
                this.open.delete(key);
            }
            if (step === null) {
                continue;
            }
            const position = this.options.position(trackId, step);
            if (position !== null) {
                this.open.set(key, { trackId, liveId, note, velocity, step, position, released: false });
            }
        }
    }

    /** A key came up at running step `step`. Under a held pedal its notes wait for the pedal-up. */
    noteOff(liveId: string, trackIds: readonly string[], step: number): void {
        for (const trackId of trackIds) {
            const key = keyOf(trackId, liveId);
            const open = this.open.get(key);
            if (!open) {
                continue;
            }
            if (this.pedal.has(trackId)) {
                open.released = true;
            } else {
                this.close(key, open, step);
            }
        }
    }

    /** The sustain pedal of these tracks went down or up at running step `step`. */
    sustain(down: boolean, trackIds: readonly string[], step: number): void {
        for (const trackId of trackIds) {
            if (down) {
                this.pedal.add(trackId);
                continue;
            }
            this.pedal.delete(trackId);
            for (const [key, open] of this.open) {
                if (open.trackId === trackId && open.released) {
                    this.close(key, open, step);
                }
            }
        }
    }

    /** All notes off (a panic, an input that went away) on these tracks, at running step `step`. */
    allNotesOff(trackIds: readonly string[], step: number): void {
        for (const [key, open] of this.open) {
            if (trackIds.includes(open.trackId)) {
                this.close(key, open, step);
            }
        }
    }

    /** Recording stops at running step `step`: every open note closes there. */
    stop(step: number): void {
        for (const [key, open] of this.open) {
            this.close(key, open, step);
        }
    }

    private close(key: string, open: OpenNote, step: number): void {
        this.open.delete(key);
        const track = this.options.track(open.trackId);
        if (!track) {
            return;
        }
        const added = track.addNote({ note: open.note, start: open.position, length: Math.max(MIN_NOTE_LENGTH, step - open.step), velocity: open.velocity });
        this.noteIds.add(added.id);
        this.notes.push({ trackId: open.trackId, note: added });
    }
}

/**
 * Replace mode: the ids of the notes starting in pattern step `step` (the step a take plays for the first time),
 * except the ones the take recorded itself.
 */
export const notesToReplace = (notes: readonly PatternNote[], step: number, keep: ReadonlySet<string>): string[] => {
    const ids: string[] = [];
    for (const note of notes) {
        if (stepOfStart(note.start) === step && !keep.has(note.id)) {
            ids.push(note.id);
        }
    }
    return ids;
};

/**
 * Which pattern steps a replace take has already cleared on one track. Every step is cleared once, the first time the
 * take plays it; after a whole pass the take overdubs.
 */
export class ReplacePass {
    private readonly cleared: Uint8Array;
    private count = 0;

    constructor(readonly length: number) {
        this.cleared = new Uint8Array(length);
    }

    /** True once every step was cleared: the first pass is over. */
    get isDone(): boolean {
        return this.count >= this.length;
    }

    /** Marks a step as cleared. True when it was not yet (the caller clears it now). */
    claim(step: number): boolean {
        const index = Math.floor(step);
        if (index < 0 || index >= this.length || this.cleared[index]) {
            return false;
        }
        this.cleared[index] = 1;
        this.count++;
        return true;
    }

    /** Whether the step holding `step` was cleared. */
    has(step: number): boolean {
        const index = Math.floor(step);
        return index >= 0 && index < this.length && this.cleared[index] === 1;
    }

    /** The steps cleared so far, for a lane that joins the take late. */
    clearedSteps(): number[] {
        const steps: number[] = [];
        for (let i = 0; i < this.length; i++) {
            if (this.cleared[i]) {
                steps.push(i);
            }
        }
        return steps;
    }
}
