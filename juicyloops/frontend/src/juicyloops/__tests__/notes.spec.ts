import { describe, expect, it } from 'vitest';
import { ALL_NOTES_DESCENDING, MAX_OCTAVE, MIN_OCTAVE, NOTE_NAMES, OCTAVES, parseNote, shiftOctave } from '../notes';

describe('notes', () => {
    it('lists every note of every octave from high to low', () => {
        expect(ALL_NOTES_DESCENDING).toHaveLength(NOTE_NAMES.length * OCTAVES.length);
        expect(ALL_NOTES_DESCENDING[0]).toBe(`B${MAX_OCTAVE}`);
        expect(ALL_NOTES_DESCENDING[ALL_NOTES_DESCENDING.length - 1]).toBe(`C${MIN_OCTAVE}`);
    });

    it('parses notes with and without accidentals', () => {
        expect(parseNote('C4')).toEqual({ name: 'C', octave: 4 });
        expect(parseNote('F#10')).toEqual({ name: 'F#', octave: 10 });
        expect(parseNote('nope')).toBeNull();
    });

    it('shifts octaves and clamps to the supported range', () => {
        expect(shiftOctave('C4', 1)).toBe('C5');
        expect(shiftOctave('D#2', -1)).toBe('D#1');
        expect(shiftOctave(`A${MAX_OCTAVE}`, 1)).toBe(`A${MAX_OCTAVE}`);
        expect(shiftOctave(`A${MIN_OCTAVE}`, -1)).toBe(`A${MIN_OCTAVE}`);
    });

    it('leaves unknown notes untouched', () => {
        expect(shiftOctave('garbage', 1)).toBe('garbage');
    });
});
