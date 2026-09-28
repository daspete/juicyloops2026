import { describe, expect, it } from 'vitest';
import { NoteStack, SustainGate } from '../midi/liveNotes';

describe('SustainGate', () => {
    it('stops a note when its key comes up while the pedal is up', () => {
        const gate = new SustainGate();
        expect(gate.press('a')).toBe(false);
        expect(gate.size).toBe(1);
        expect(gate.release('a')).toBe(true);
        expect(gate.size).toBe(0);
        expect(gate.release('a')).toBe(false);
    });

    it('holds note-offs while the pedal is down and releases them when it comes up', () => {
        const gate = new SustainGate();
        gate.press('a');
        gate.press('b');
        expect(gate.pedal(true)).toEqual([]);
        expect(gate.release('a')).toBe(false);
        expect(gate.has('a')).toBe(true);
        gate.press('c');
        expect(gate.pedal(false).sort()).toEqual(['a']);
        expect(gate.has('b')).toBe(true);
        expect(gate.has('c')).toBe(true);
        expect(gate.release('b')).toBe(true);
    });

    it('restarts a key struck again while the pedal still holds it, and keeps it held by its key', () => {
        const gate = new SustainGate();
        gate.pedal(true);
        gate.press('a');
        gate.release('a');
        expect(gate.press('a')).toBe(true);
        // The key is down again: pedal-up no longer releases it.
        expect(gate.pedal(false)).toEqual([]);
        expect(gate.release('a')).toBe(true);
    });

    it('drops everything on all notes off, keeping the pedal', () => {
        const gate = new SustainGate();
        gate.press('a');
        gate.pedal(true);
        gate.release('a');
        gate.press('b');
        expect(gate.clear().sort()).toEqual(['a', 'b']);
        expect(gate.size).toBe(0);
        expect(gate.isDown).toBe(true);
        expect(gate.pedal(false)).toEqual([]);
    });
});

describe('NoteStack (last-note priority)', () => {
    it('gives the newest note the voice and falls back to the newest one still held', () => {
        const stack = new NoteStack<string>();
        stack.press('a', 'C5');
        stack.press('b', 'E5');
        stack.press('c', 'G5');
        expect(stack.current?.value).toBe('G5');
        // A key that is not sounding changes nothing.
        expect(stack.release('b')).toBeUndefined();
        // The sounding one comes up: the newest still held takes over.
        expect(stack.release('c')).toEqual({ id: 'a', value: 'C5' });
        expect(stack.release('a')).toBeNull();
        expect(stack.size).toBe(0);
    });

    it('moves a note pressed again to the top', () => {
        const stack = new NoteStack<number>();
        stack.press('a', 1);
        stack.press('b', 2);
        stack.press('a', 3);
        expect(stack.size).toBe(2);
        expect(stack.release('a')).toEqual({ id: 'b', value: 2 });
        expect(stack.release('x')).toBeUndefined();
    });
});
