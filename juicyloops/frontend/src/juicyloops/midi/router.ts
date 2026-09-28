import { liveNoteId, midiNoteName, type MidiMessage } from './messages';

/**
 * Sends what comes in from the MIDI inputs to the tracks that play it.
 *
 * Every event goes to every **armed** track, whatever its channel; when no track is armed, the selected track counts
 * as armed (the caller's `armed` function decides that). A note-off always goes to the tracks its note-on went to,
 * even when arming changed in between, and a pedal-up reaches every track the pedal went down on, so nothing hangs.
 *
 * Every routed event is also handed to the subscribers (`subscribe`), with the time it was played at and the tracks it
 * went to. That is the hook the recorder (Phase 4 of notes/midi-recording.md) and the activity light listen on.
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
}

export type MidiRouterListener = (event: MidiRouterEvent) => void;

export interface MidiRouterOptions {
    /** The tracks that play input right now (the armed ones, or the selected one). Raw objects, not Vue proxies. */
    armed: () => readonly LiveTrack[];
    /** The audio-context time now; live events play at once. */
    now: () => number;
    /** Called before a note-on reaches a track, e.g. to wake a sleeping container (see `hibernate.ts`). */
    wake?: (track: LiveTrack) => void;
}

const NO_TRACKS: readonly LiveTrack[] = Object.freeze([]);

export class MidiRouter {
    /** Per live note id, the tracks its note-on went to. */
    private readonly notes = new Map<string, readonly LiveTrack[]>();
    /** Tracks the pedal went down on, by id. */
    private readonly sustained = new Map<string, LiveTrack>();
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
                const tracks = this.options.armed();
                const previous = this.notes.get(id);
                if (previous) {
                    // The same key again without a note-off: whatever still plays it elsewhere stops.
                    for (const track of previous) {
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
                this.notes.set(id, tracks.length ? [...tracks] : NO_TRACKS);
                this.emit({ type: 'noteon', input, channel: message.channel, id, note: message.note, velocity: message.velocity, timeStamp, time }, tracks);
                return;
            }
            case 'noteoff': {
                const id = liveNoteId(input, message.channel, message.note);
                const tracks = this.notes.get(id) ?? NO_TRACKS;
                this.notes.delete(id);
                for (const track of tracks) {
                    track.noteOff(id, time);
                }
                this.emit({ type: 'noteoff', input, channel: message.channel, id, note: message.note, velocity: message.velocity, timeStamp, time }, tracks);
                return;
            }
            case 'sustain': {
                let tracks: readonly LiveTrack[];
                if (message.down) {
                    tracks = this.options.armed();
                    for (const track of tracks) {
                        this.sustained.set(track.id, track);
                    }
                } else {
                    tracks = this.union(this.options.armed(), this.sustained);
                    this.sustained.clear();
                }
                for (const track of tracks) {
                    track.setSustain(message.down, time);
                }
                this.emit({ type: 'sustain', input, channel: message.channel, cc: 64, value: message.value, timeStamp, time }, tracks);
                return;
            }
            case 'bend': {
                const tracks = this.union(this.options.armed(), this.bent);
                for (const track of tracks) {
                    track.setLiveBend(message.value, time);
                    this.bent.set(track.id, track);
                }
                if (message.value === 0) {
                    this.bent.clear();
                }
                this.emit({ type: 'bend', input, channel: message.channel, value: message.value, timeStamp, time }, tracks);
                return;
            }
            case 'cc': {
                const tracks = this.options.armed();
                this.emit({ type: 'cc', input, channel: message.channel, cc: message.controller, value: message.value, timeStamp, time }, tracks);
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
        for (const [id, noteTracks] of this.notes) {
            if (input !== undefined && !id.startsWith(`${input}:`)) {
                continue;
            }
            this.notes.delete(id);
            for (const track of noteTracks) {
                tracks.set(track.id, track);
            }
        }
        if (input === undefined) {
            for (const track of this.sustained.values()) {
                tracks.set(track.id, track);
            }
            this.sustained.clear();
        }
        for (const track of tracks.values()) {
            track.allNotesOff(time);
        }
        this.emit({ type: 'allnotesoff', input: input ?? '', channel, timeStamp, time }, [...tracks.values()]);
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

    private emit(event: Omit<MidiRouterEvent, 'trackIds'>, tracks: readonly LiveTrack[]): void {
        if (!this.listeners.size) {
            return;
        }
        const routed: MidiRouterEvent = { ...event, trackIds: tracks.map((track) => track.id) };
        for (const listener of this.listeners) {
            listener(routed);
        }
    }
}
