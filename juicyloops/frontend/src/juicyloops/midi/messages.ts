import { noteAt } from '../notes';

/**
 * Parses raw MIDI channel messages (what a Web MIDI input hands out in `MIDIMessageEvent.data`) into the few kinds
 * JuicyLoops plays: notes, controllers (CC64 is the sustain pedal), pitch bend, and the "all notes off" controllers.
 * Everything else (aftertouch, program change, system messages, sysex) is ignored.
 *
 * Pure and allocation-light: it runs for every incoming message.
 */

/** The controller number of the sustain (damper) pedal. */
export const SUSTAIN_CC = 64;
/** "All sound off" and "all notes off": both silence every held note. */
export const ALL_SOUND_OFF_CC = 120;
export const ALL_NOTES_OFF_CC = 123;

/** Channels are 0..15 here (shown as 1..16). Velocities are 0..1, controller values 0..127, bend -1..1. */
export type MidiMessage =
    | { type: 'noteon'; channel: number; note: number; velocity: number }
    /** A note-off, or a note-on with velocity 0 (running-status keyboards send those). */
    | { type: 'noteoff'; channel: number; note: number; velocity: number }
    | { type: 'cc'; channel: number; controller: number; value: number }
    /** CC64: down at a value of 64 or more. */
    | { type: 'sustain'; channel: number; down: boolean; value: number }
    /** 14 bit, centre 8192, as -1..1 (both ends reach exactly ±1). */
    | { type: 'bend'; channel: number; value: number }
    /** CC120 or CC123. */
    | { type: 'allnotesoff'; channel: number };

/** The pitch bend of a 14-bit value (0..16383) as -1..1, 0 at the centre (8192). */
export const bendValue = (raw: number): number => (raw >= 8192 ? (raw - 8192) / 8191 : (raw - 8192) / 8192);

/** One message, or null when it is not one we play (or is cut short). */
export const parseMidiMessage = (data: ArrayLike<number>): MidiMessage | null => {
    if (data.length < 2) {
        return null;
    }
    const status = data[0]!;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const first = data[1]! & 0x7f;
    const second = data.length > 2 ? data[2]! & 0x7f : 0;
    switch (kind) {
        case 0x90:
            if (data.length < 3) {
                return null;
            }
            return second === 0 ? { type: 'noteoff', channel, note: first, velocity: 0 } : { type: 'noteon', channel, note: first, velocity: second / 127 };
        case 0x80:
            if (data.length < 3) {
                return null;
            }
            return { type: 'noteoff', channel, note: first, velocity: second / 127 };
        case 0xb0:
            if (data.length < 3) {
                return null;
            }
            if (first === SUSTAIN_CC) {
                return { type: 'sustain', channel, down: second >= 64, value: second };
            }
            if (first === ALL_NOTES_OFF_CC || first === ALL_SOUND_OFF_CC) {
                return { type: 'allnotesoff', channel };
            }
            return { type: 'cc', channel, controller: first, value: second };
        case 0xe0:
            if (data.length < 3) {
                return null;
            }
            return { type: 'bend', channel, value: bendValue(first | (second << 7)) };
        default:
            return null;
    }
};

/** The id of a live note: which input, channel and key. A note-off finds its note-on by it. */
export const liveNoteId = (input: string, channel: number, note: number): string => `${input}:${channel}:${note}`;

/**
 * The app's note name for a MIDI key, at standard pitch: key 69 is A4 (440 Hz), key 60 (middle C) is 'C4'. The app's
 * names follow Tone's (`noteIndex('C5') === 60` semitones above C0), so key `n` is `noteAt(n - 12)`. A sampler plays
 * its sample unchanged at its root, 'C5' (`SAMPLE_ROOT_NOTE`), which is key 72. The one mapping from keys to notes:
 * live playing and recording both use it.
 */
export const midiNoteName = (note: number): string => noteAt(note - 12);
