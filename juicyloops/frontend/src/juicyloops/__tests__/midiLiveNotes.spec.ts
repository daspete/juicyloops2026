import { describe, expect, it } from 'vitest';
import { computed } from 'vue';
import { heldKeysOf, publishHeldKeys } from '../midi/heldKeys';
import { NO_HELD_KEYS, NoteStack, SustainGate } from '../midi/liveNotes';

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

describe('held keys (piano roll lighting)', () => {
    it('lists the sounding keys by name, held by a key or by the pedal', () => {
        const gate = new SustainGate();
        expect(gate.keys()).toBe(NO_HELD_KEYS);
        gate.press('in:0:60', 'C4');
        gate.press('in:0:64', 'E4');
        expect([...gate.keys()]).toEqual([
            ['C4', 'held'],
            ['E4', 'held'],
        ]);
        gate.pedal(true);
        gate.release('in:0:60');
        expect(gate.keys().get('C4')).toBe('sustained');
        // The same key from another input, held down: held wins.
        gate.press('other:0:60', 'C4');
        expect(gate.keys().get('C4')).toBe('held');
        gate.release('other:0:60');
        gate.release('in:0:64');
        expect([...gate.keys().values()]).toEqual(['sustained', 'sustained']);
        gate.pedal(false);
        expect(gate.keys()).toBe(NO_HELD_KEYS);
    });

    it('updates a reader of one track only when that track changes', () => {
        let runs = 0;
        const lit = computed(() => {
            runs++;
            return [...heldKeysOf('t1')];
        });
        expect(lit.value).toEqual([]);
        publishHeldKeys('t1', new Map([['C4', 'held']]));
        expect(lit.value).toEqual([['C4', 'held']]);
        const after = runs;
        // Another track, or the same keys again: nothing to recompute.
        publishHeldKeys('t2', new Map([['D4', 'held']]));
        publishHeldKeys('t1', new Map([['C4', 'held']]));
        expect(lit.value).toEqual([['C4', 'held']]);
        expect(runs).toBe(after);
        publishHeldKeys('t1', new Map([['C4', 'sustained']]));
        expect(lit.value).toEqual([['C4', 'sustained']]);
        publishHeldKeys('t1', NO_HELD_KEYS);
        expect(lit.value).toEqual([]);
        expect(heldKeysOf('t1')).toBe(NO_HELD_KEYS);
        publishHeldKeys('t2', NO_HELD_KEYS);
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
