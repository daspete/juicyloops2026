import { markRaw, toRaw } from 'vue';
import { normalizeTrackLength, STEP_COUNT } from '../constants';
import { createId } from '../ids';
import { DEFAULT_STEP_NOTE, shiftOctave } from '../notes';
import { byStart, copyNote, MIN_NOTE_LENGTH, normalizeNoteValues, stepOfStart, wrapStart, type NoteInput, type PatternNote } from './Note';

const NO_NOTES: readonly PatternNote[] = Object.freeze([]);

/**
 * The notes of a pattern and its length: what every track plays. `BaseTrack` extends it; on its own it is plain
 * data (no audio), so the model can be tested without Web Audio.
 *
 * `notes` stays sorted by start. Every edit goes through the methods here, which keep that order and bump
 * `revision`; the step callback's index (`notesStartingAt`) is rebuilt only when `revision` or `length` changed.
 * Edits made through Vue's proxy are fine: the index is always built from the raw objects.
 */
export class NotePattern {
    /** Sorted by start. Read it freely; change it only through the methods below. */
    notes: PatternNote[] = [];

    /** Length of the pattern in steps. */
    length: number;

    /** Bumped by every edit of the notes or the length. */
    revision = 0;

    /** The pitch a step switched on in the grid gets: the last pitch placed. Not saved. */
    stepNote: string = DEFAULT_STEP_NOTE;

    /** The length (steps) a step switched on in the grid gets. `setAllNoteLengths` sets it too. Not saved. */
    stepLength = 1;

    /** Per step of the pattern, the notes starting in it (the step callback's index). Built from raw notes, never proxied. */
    private buckets: PatternNote[][] = markRaw([]);
    private bucketRevision = -1;
    private bucketLength = -1;

    constructor(length = STEP_COUNT) {
        this.length = normalizeTrackLength(length);
    }

    /* ---- reading ---- */

    /**
     * The notes starting in `[position, position + 1)`, in start order. For the step callback: allocation-free
     * unless the notes or the length changed since the last call. Do not keep or change the array.
     */
    notesStartingAt(position: number): readonly PatternNote[] {
        const raw = toRaw(this);
        if (raw.bucketRevision !== raw.revision || raw.bucketLength !== raw.length) {
            raw.rebuildBuckets();
        }
        return raw.buckets[position] ?? NO_NOTES;
    }

    getNote(id: string): PatternNote | undefined {
        return this.notes.find((note) => note.id === id);
    }

    /** The longest note, in steps (0 without notes). */
    get longestNote(): number {
        let longest = 0;
        for (const note of this.notes) {
            longest = Math.max(longest, note.length);
        }
        return longest;
    }

    private rebuildBuckets(): void {
        const buckets = this.buckets;
        for (let i = 0; i < buckets.length; i++) {
            buckets[i]!.length = 0;
        }
        while (buckets.length < this.length) {
            buckets.push([]);
        }
        buckets.length = this.length;
        for (const note of this.notes) {
            buckets[Math.min(this.length - 1, stepOfStart(note.start))]!.push(note);
        }
        this.bucketRevision = this.revision;
        this.bucketLength = this.length;
    }

    /* ---- editing ---- */

    private touch(): void {
        this.revision++;
    }

    private create(input: NoteInput): PatternNote {
        return normalizeNoteValues({ id: input.id ?? createId(), note: input.note, start: input.start, length: input.length, velocity: input.velocity ?? 1 }, this.length);
    }

    /** Inserts a note behind every note with the same or an earlier start (the list stays sorted, equal starts keep their order). */
    private insert(note: PatternNote): void {
        const notes = this.notes;
        let low = 0;
        let high = notes.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (notes[mid]!.start <= note.start) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        notes.splice(low, 0, note);
    }

    /** Adds a note. Its start is wrapped into the pattern. Returns the note as stored. */
    addNote(input: NoteInput): PatternNote {
        const note = this.create(input);
        this.insert(note);
        this.stepNote = note.note;
        this.touch();
        return note;
    }

    /** Changes a note; the start is wrapped into the pattern. Returns the note, or undefined when there is none with that id. */
    updateNote(id: string, changes: Partial<Omit<PatternNote, 'id'>>): PatternNote | undefined {
        const index = this.notes.findIndex((note) => note.id === id);
        const note = this.notes[index];
        if (!note) {
            return undefined;
        }
        const next = normalizeNoteValues({ start: note.start, length: note.length, velocity: note.velocity, ...changes }, this.length);
        if (changes.note !== undefined) {
            note.note = changes.note;
            this.stepNote = changes.note;
        }
        note.length = next.length;
        note.velocity = next.velocity;
        if (next.start !== note.start) {
            this.notes.splice(index, 1);
            note.start = next.start;
            this.insert(note);
        }
        this.touch();
        return note;
    }

    /**
     * Adds several notes at once (a paste, a duplicate): one re-sort, one revision. Starts are wrapped into the
     * pattern. Returns the notes as stored, in the order given.
     */
    addNotes(inputs: readonly NoteInput[]): PatternNote[] {
        if (!inputs.length) {
            return [];
        }
        const added = inputs.map((input) => this.create(input));
        this.notes.push(...added);
        this.notes.sort(byStart);
        this.stepNote = added[added.length - 1]!.note;
        this.touch();
        return added;
    }

    /**
     * Changes several notes at once (a group move, a quantize, a velocity sweep): one re-sort, one revision. Unknown
     * ids are skipped. Notes that keep an equal start keep their order.
     */
    updateNotes(changes: readonly ({ id: string } & Partial<Omit<PatternNote, 'id'>>)[]): void {
        if (!changes.length) {
            return;
        }
        const byId = new Map(this.notes.map((note) => [note.id, note]));
        let moved = false;
        for (const change of changes) {
            const note = byId.get(change.id);
            if (!note) {
                continue;
            }
            const next = normalizeNoteValues(
                { start: change.start ?? note.start, length: change.length ?? note.length, velocity: change.velocity ?? note.velocity },
                this.length,
            );
            if (change.note !== undefined) {
                note.note = change.note;
                this.stepNote = change.note;
            }
            moved ||= next.start !== note.start;
            note.start = next.start;
            note.length = next.length;
            note.velocity = next.velocity;
        }
        if (moved) {
            this.notes.sort(byStart);
        }
        this.touch();
    }

    /** Removes the notes with these ids. */
    removeNotes(ids: Iterable<string>): void {
        const gone = new Set(ids);
        if (!gone.size) {
            return;
        }
        const kept = this.notes.filter((note) => !gone.has(note.id));
        if (kept.length !== this.notes.length) {
            this.notes.splice(0, this.notes.length, ...kept);
            this.touch();
        }
    }

    /**
     * Replaces every note. Notes whose id is still there keep their object (the views then do not re-render from
     * scratch); the others are made anew.
     */
    setNotes(inputs: readonly NoteInput[]): void {
        const existing = new Map(this.notes.map((note) => [note.id, note]));
        const next = inputs.map((input) => {
            const fresh = this.create(input);
            const kept = input.id === undefined ? undefined : existing.get(input.id);
            if (!kept) {
                return fresh;
            }
            existing.delete(input.id!);
            kept.note = fresh.note;
            kept.start = fresh.start;
            kept.length = fresh.length;
            kept.velocity = fresh.velocity;
            return kept;
        });
        next.sort(byStart);
        this.notes.splice(0, this.notes.length, ...next);
        this.touch();
    }

    /** Changes the length of the pattern. Notes starting past the new end are dropped; the others keep their length, so tails ring across the wrap. */
    setLength(length: number): void {
        const target = normalizeTrackLength(length);
        this.length = target;
        const kept = this.notes.filter((note) => note.start < target);
        if (kept.length !== this.notes.length) {
            this.notes.splice(0, this.notes.length, ...kept);
        }
        this.touch();
    }

    /** Copies of the notes, for history and files. */
    serializeNotes(): PatternNote[] {
        return this.notes.map(copyNote);
    }

    /* ---- pattern tools ---- */

    /**
     * Switches steps on and off: a step that stays on keeps the notes starting in it, an empty one that is switched
     * on gets a note at `stepNote` and `stepLength`; every other note goes.
     */
    private fillSteps(isOn: (step: number) => boolean): void {
        const byStep = new Map<number, PatternNote[]>();
        for (const note of this.notes) {
            const step = stepOfStart(note.start);
            byStep.set(step, [...(byStep.get(step) ?? []), note]);
        }
        const next: NoteInput[] = [];
        for (let step = 0; step < this.length; step++) {
            if (!isOn(step)) {
                continue;
            }
            const notes = byStep.get(step);
            if (notes) {
                next.push(...notes);
            } else {
                next.push({ note: this.stepNote, start: step, length: this.stepLength, velocity: 1 });
            }
        }
        this.setNotes(next);
    }

    /** One note on every `interval`-th step, none on the others. */
    activateEveryNth(interval: number): void {
        this.fillSteps((step) => step % interval === 0);
    }

    /** A random selection of steps holds a note. `density` is the share of steps that do (0..1). */
    randomize(density = 0.4): void {
        this.fillSteps(() => Math.random() < density);
    }

    /** Moves every note one step later (`1`) or earlier (`-1`); starts wrap around the pattern. */
    rotate(direction: 1 | -1): void {
        this.setNotes(this.notes.map((note) => ({ ...copyNote(note), start: wrapStart(note.start + direction, this.length) })));
    }

    /** Removes every note. */
    clear(): void {
        if (this.notes.length) {
            this.notes.splice(0);
            this.touch();
        }
    }

    /** Moves every note up (`1`) or down (`-1`) by one octave, each clamped to the supported range. */
    shiftOctave(direction: 1 | -1): void {
        for (const note of this.notes) {
            note.note = shiftOctave(note.note, direction);
        }
        this.stepNote = shiftOctave(this.stepNote, direction);
        this.touch();
    }

    /** Gives every note the same length (steps); steps switched on later get it too. */
    setAllNoteLengths(steps: number): void {
        const length = Math.max(MIN_NOTE_LENGTH, steps);
        for (const note of this.notes) {
            note.length = length;
        }
        this.stepLength = length;
        this.touch();
    }
}
