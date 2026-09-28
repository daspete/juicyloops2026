import { describe, expect, it } from 'vitest';
import { noteIndex } from '../notes';
import { bendValue, liveNoteId, midiNoteName, parseMidiMessage } from '../midi/messages';

describe('MIDI message parser', () => {
    it('reads note-on and note-off with velocity and channel', () => {
        expect(parseMidiMessage([0x90, 60, 127])).toEqual({ type: 'noteon', channel: 0, note: 60, velocity: 1 });
        expect(parseMidiMessage([0x93, 64, 64])).toEqual({ type: 'noteon', channel: 3, note: 64, velocity: 64 / 127 });
        expect(parseMidiMessage([0x8f, 60, 40])).toEqual({ type: 'noteoff', channel: 15, note: 60, velocity: 40 / 127 });
    });

    it('counts a note-on with velocity 0 as a note-off', () => {
        expect(parseMidiMessage([0x91, 72, 0])).toEqual({ type: 'noteoff', channel: 1, note: 72, velocity: 0 });
    });

    it('reads controllers, CC64 as the sustain pedal and CC120/123 as all notes off', () => {
        expect(parseMidiMessage([0xb0, 74, 100])).toEqual({ type: 'cc', channel: 0, controller: 74, value: 100 });
        expect(parseMidiMessage([0xb2, 64, 127])).toEqual({ type: 'sustain', channel: 2, down: true, value: 127 });
        expect(parseMidiMessage([0xb2, 64, 63])).toEqual({ type: 'sustain', channel: 2, down: false, value: 63 });
        expect(parseMidiMessage([0xb0, 64, 64])).toMatchObject({ down: true });
        expect(parseMidiMessage([0xb0, 123, 0])).toEqual({ type: 'allnotesoff', channel: 0 });
        expect(parseMidiMessage([0xb5, 120, 0])).toEqual({ type: 'allnotesoff', channel: 5 });
    });

    it('reads 14-bit pitch bend as -1..1 with the centre at 0', () => {
        expect(parseMidiMessage([0xe0, 0x00, 0x40])).toEqual({ type: 'bend', channel: 0, value: 0 });
        expect(parseMidiMessage([0xe1, 0x7f, 0x7f])).toEqual({ type: 'bend', channel: 1, value: 1 });
        expect(parseMidiMessage([0xe0, 0x00, 0x00])).toEqual({ type: 'bend', channel: 0, value: -1 });
        expect(bendValue(8192 + 4096)).toBeCloseTo(0.5, 3);
        expect(bendValue(4096)).toBe(-0.5);
    });

    it('ignores what it does not play and messages cut short', () => {
        expect(parseMidiMessage([0xc0, 5])).toBeNull(); // program change
        expect(parseMidiMessage([0xd0, 5])).toBeNull(); // channel pressure
        expect(parseMidiMessage([0xa0, 60, 5])).toBeNull(); // poly aftertouch
        expect(parseMidiMessage([0xf8])).toBeNull(); // clock
        expect(parseMidiMessage([0xf0, 1, 2, 0xf7])).toBeNull(); // sysex
        expect(parseMidiMessage([0x90, 60])).toBeNull();
        expect(parseMidiMessage([])).toBeNull();
    });

    it('masks data bytes to seven bits', () => {
        expect(parseMidiMessage(new Uint8Array([0x90, 0xbc, 0xff]))).toEqual({ type: 'noteon', channel: 0, note: 60, velocity: 1 });
    });

    it('gives every key of every channel and input its own id', () => {
        expect(liveNoteId('in-1', 0, 60)).toBe('in-1:0:60');
        expect(liveNoteId('in-1', 1, 60)).not.toBe(liveNoteId('in-1', 0, 60));
    });

    it('names keys at standard pitch: middle C (60) is C4, A 440 (69) is A4, the sampler root C5 is key 72', () => {
        expect(midiNoteName(60)).toBe('C4');
        expect(midiNoteName(69)).toBe('A4');
        expect(midiNoteName(72)).toBe('C5');
        for (let key = 12; key < 128; key++) {
            expect(noteIndex(midiNoteName(key))).toBe(key - 12);
        }
    });
});
