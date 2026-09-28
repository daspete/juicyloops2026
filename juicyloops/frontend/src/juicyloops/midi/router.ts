import { liveNoteId, midiNoteName, type MidiMessage } from './messages';

/**
 * Sends what comes in from the MIDI inputs to the tracks that play it.
 *
 * Two sets of tracks, both decided by the caller:
 * - `live()`: the tracks that **play** what comes in, whatever its channel (in the studio: every armed track plus the
 *   selected one);
 * - `recordTargets()`: the tracks a take **records** into (every armed track, or the selected one when none is armed).
 *   Always among the live tracks; a track that only plays (selected, not armed, while others are) is not recorded.
 *
 * A note-off always goes to the tracks its note-on went to, even when arming or the selection changed in between, and
 * a pedal-up reaches every track the pedal went down on, so nothing hangs. The same holds for recording: a note-off
 * closes the note on the tracks its note-on recorded into.
 *
 * Every routed event is also handed to the subscribers (`subscribe`), with the time it was played at, the tracks it
 * went to and those of them that record it. That is the hook the recorder (Phase 4 of notes/midi-recording.md) and the
 * activity light listen on.
 */

/** What the router needs of a track. `BaseTrack` is one; the router calls it on the raw object. */
export interface LiveTrack {
    readonly id: string;
    /** `note` is a note name ('C4'); `velocity` 0..1; `time` audio-context seconds. */
    noteOn(id: string, note: string, velocity: number, time: number): void;
    noteOff(id: string, time: number): void;
    setSustain(down: boolean, time: number): void;
    /** Pitch bend, -1..1 (the track scales it by its own range). */
    setLiveBend(value: number, time: number): void;
    allNotesOff(time: number): void;
}

/** One event as the subscribers see it. */
export interface MidiRouterEvent {
    type: MidiMessage['type'];
    /** The input (its Web MIDI id) the message came from. */
    input: string;
    /** 0..15. */
    channel: number;
    /** Notes: `${input}:${channel}:${note}`, the same for the note-on and its note-off. */
    id?: string;
    /** Notes: the MIDI note number (60 is middle C, played as 'C4': `midiNoteName`). */
    note?: number;
    /** Notes: 0..1 (0 for a note-off sent as a note-on with velocity 0). */
    velocity?: number;
    /** Controllers: the controller number (64 for the sustain pedal). */
    cc?: number;
    /** Controllers: 0..127. Pitch bend: -1..1. Sustain: 0..127 (down from 64). */
    value?: number;
    /** When the message arrived, in the `performance.now()` clock (`MIDIMessageEvent.timeStamp`). */
    timeStamp: number;
    /** The audio-context time the event was played at (`context.currentTime` when it was routed). */
    time: number;
    /** The tracks it went to. Empty for a controller no track plays (the subscriber decides what to do with it). */
    trackIds: readonly string[];
    /**
     * The tracks among `trackIds` that record it (`recordTargets`). A note-off: those its note-on recorded into; a
     * pedal-up: those the pedal went down on as record targets, plus the record targets now.
     */
    recordTrackIds: readonly string[];
}

export type MidiRouterListener = (event: MidiRouterEvent) => void;

export interface MidiRouterOptions {
    /** The tracks that play input right now (the armed ones plus the selected one). Raw objects, not Vue proxies. */
    live: () => readonly LiveTrack[];
    /**
     * The tracks that record input right now (the armed ones, or the selected one when none is armed). Only their ids
     * are used; a record target that is not live gets nothing. Defaults to `live`.
     */
    recordTargets?: () => readonly LiveTrack[];
    /** The audio-context time now; live events play at once. */
    now: () => number;
    /** Called before a note-on reaches a track, e.g. to wake a sleeping container (see `hibernate.ts`). */
    wake?: (track: LiveTrack) => void;
}

const NO_TRACKS: readonly LiveTrack[] = Object.freeze([]);
const NO_IDS: readonly string[] = Object.freeze([]);

/** The tracks a note-on went to, and the ids of those that record it. */
interface RoutedNote {
    tracks: readonly LiveTrack[];
    record: readonly string[];
}

export class MidiRouter {
    /** Per live note id, the tracks its note-on went to. */
    private readonly notes = new Map<string, RoutedNote>();
    /** Tracks the pedal went down on, by id. */
    private readonly sustained = new Map<string, LiveTrack>();
    /** Ids of the tracks the pedal went down on as record targets. */
    private readonly sustainedRecord = new Set<string>();
    /** Tracks that were bent, so a bend back to the centre reaches them even after they were disarmed. */
    private readonly bent = new Map<string, LiveTrack>();
    private readonly listeners = new Set<MidiRouterListener>();

    constructor(private readonly options: MidiRouterOptions) {}

    /** Registers a listener for every routed event. Returns the function that removes it. */
    subscribe(listener: MidiRouterListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** How many notes are held (by key) right now. */
    get heldNotes(): number {
        return this.notes.size;
    }

    /** Plays one parsed message from `input`, received at `timeStamp` (performance clock). */
    handle(input: string, message: MidiMessage, timeStamp: number): void {
        const time = this.options.now();
        switch (message.type) {
            case 'noteon': {
                const id = liveNoteId(input, message.channel, message.note);
                const tracks = this.options.live();
                const previous = this.notes.get(id);
                if (previous) {
                    // The same key again without a note-off: whatever still plays it elsewhere stops.
                    for (const track of previous.tracks) {
                        if (!tracks.includes(track)) {
                            track.noteOff(id, time);
                        }
                    }
                }
                const name = midiNoteName(message.note);
                for (const track of tracks) {
                    this.options.wake?.(track);
                    track.noteOn(id, name, message.velocity, time);
                }
                const record = this.recordIdsAmong(tracks);
                this.notes.set(id, { tracks: tracks.length ? [...tracks] : NO_TRACKS, record });
                this.emit({ type: 'noteon', input, channel: message.channel, id, note: message.note, velocity: message.velocity, timeStamp, time }, tracks, record);
                return;
            }
            case 'noteoff': {
                const id = liveNoteId(input, message.channel, message.note);
                const routed = this.notes.get(id);
                const tracks = routed?.tracks ?? NO_TRACKS;
                this.notes.delete(id);
                for (const track of tracks) {
                    track.noteOff(id, time);
                }
                this.emit({ type: 'noteoff', input, channel: message.channel, id, note: message.note, velocity: message.velocity, timeStamp, time }, tracks, routed?.record ?? NO_IDS);
                return;
            }
            case 'sustain': {
                let tracks: readonly LiveTrack[];
                let record: readonly string[];
                if (message.down) {
                    tracks = this.options.live();
                    record = this.recordIdsAmong(tracks);
                    for (const track of tracks) {
                        this.sustained.set(track.id, track);
                    }
                    for (const trackId of record) {
                        this.sustainedRecord.add(trackId);
                    }
                } else {
                    tracks = this.union(this.options.live(), this.sustained);
                    const now = this.recordIdsAmong(tracks);
                    record = this.sustainedRecord.size ? [...new Set([...this.sustainedRecord, ...now])] : now;
                    this.sustained.clear();
                    this.sustainedRecord.clear();
                }
                for (const track of tracks) {
                    track.setSustain(message.down, time);
                }
                this.emit({ type: 'sustain', input, channel: message.channel, cc: 64, value: message.value, timeStamp, time }, tracks, record);
                return;
            }
            case 'bend': {
                const tracks = this.union(this.options.live(), this.bent);
                for (const track of tracks) {
                    track.setLiveBend(message.value, time);
                    this.bent.set(track.id, track);
                }
                if (message.value === 0) {
                    this.bent.clear();
                }
                this.emit({ type: 'bend', input, channel: message.channel, value: message.value, timeStamp, time }, tracks, this.recordIdsAmong(tracks));
                return;
            }
            case 'cc': {
                const tracks = this.options.live();
                this.emit({ type: 'cc', input, channel: message.channel, cc: message.controller, value: message.value, timeStamp, time }, tracks, this.recordIdsAmong(tracks));
                return;
            }
            case 'allnotesoff':
                this.allNotesOff(timeStamp, input, message.channel);
                return;
        }
    }

    /**
     * Silences every note the router started (a panic, an input that was unplugged or switched off). With `input`,
     * only that input's notes stop.
     */
    allNotesOff(timeStamp = performance.now(), input?: string, channel = 0): void {
        const time = this.options.now();
        const tracks = new Map<string, LiveTrack>();
        const record = new Set<string>();
        for (const [id, routed] of this.notes) {
            if (input !== undefined && !id.startsWith(`${input}:`)) {
                continue;
            }
            this.notes.delete(id);
            for (const track of routed.tracks) {
                tracks.set(track.id, track);
            }
            for (const trackId of routed.record) {
                record.add(trackId);
            }
        }
        if (input === undefined) {
            for (const track of this.sustained.values()) {
                tracks.set(track.id, track);
            }
            for (const trackId of this.sustainedRecord) {
                record.add(trackId);
            }
            this.sustained.clear();
            this.sustainedRecord.clear();
        }
        for (const track of tracks.values()) {
            track.allNotesOff(time);
        }
        this.emit({ type: 'allnotesoff', input: input ?? '', channel, timeStamp, time }, [...tracks.values()], [...record]);
    }

    private union(tracks: readonly LiveTrack[], extra: ReadonlyMap<string, LiveTrack>): readonly LiveTrack[] {
        if (!extra.size) {
            return tracks;
        }
        const all = new Map<string, LiveTrack>(extra);
        for (const track of tracks) {
            all.set(track.id, track);
        }
        return [...all.values()];
    }

    /** The ids of those of `tracks` that record right now. */
    private recordIdsAmong(tracks: readonly LiveTrack[]): readonly string[] {
        if (!tracks.length) {
            return NO_IDS;
        }
        const targets = this.options.recordTargets ? this.options.recordTargets() : tracks;
        const ids: string[] = [];
        for (const track of tracks) {
            if (targets.some((target) => target.id === track.id)) {
                ids.push(track.id);
            }
        }
        return ids;
    }

    private emit(event: Omit<MidiRouterEvent, 'trackIds' | 'recordTrackIds'>, tracks: readonly LiveTrack[], record: readonly string[]): void {
        if (!this.listeners.size) {
            return;
        }
        const routed: MidiRouterEvent = { ...event, trackIds: tracks.map((track) => track.id), recordTrackIds: record };
        for (const listener of this.listeners) {
            listener(routed);
        }
    }
}
