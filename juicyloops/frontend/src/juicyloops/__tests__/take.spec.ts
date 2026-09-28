import { describe, expect, it } from 'vitest';
import { clearLaneStep, ControllerThinner, CC_MAX_PER_STEP, inStretch, writeRecordedPoint } from '../midi/laneRecord';
import { notesToReplace, ReplacePass, Take } from '../midi/take';
import { NotePattern } from '../notes/NotePattern';
import type { AutomationPoint } from '../automation';
import { firstPointAfter } from '../automation';

/** Two 16-step tracks in loop mode: the running step wrapped. `playing` false: nothing is playing (not recorded). */
const setup = (length = 16) => {
    const tracks = new Map([
        ['a', Object.assign(new NotePattern(length), { id: 'a' })],
        ['b', Object.assign(new NotePattern(length), { id: 'b' })],
    ]);
    let playing = true;
    const take = new Take({
        track: (id) => tracks.get(id),
        position: (_id, step) => (playing ? ((step % length) + length) % length : null),
    });
    const notes = (id: string) => tracks.get(id)!.notes.map((note) => ({ note: note.note, start: +note.start.toFixed(6), length: +note.length.toFixed(6), velocity: note.velocity }));
    return { take, tracks, notes, stopPlaying: () => (playing = false) };
};

describe('take assembly', () => {
    it('opens on note-on and closes on note-off with the length held, adding the note when it closes', () => {
        const { take, notes } = setup();
        take.noteOn('k60', 'C4', 0.8, ['a'], 2.25);
        expect(notes('a')).toEqual([]);
        expect(take.openCount).toBe(1);
        take.noteOff('k60', ['a'], 3.75);
        expect(notes('a')).toEqual([{ note: 'C4', start: 2.25, length: 1.5, velocity: 0.8 }]);
        expect(take.openCount).toBe(0);
        expect(take.noteIds.size).toBe(1);
    });

    it('records overlapping notes and chords, on every track the notes went to', () => {
        const { take, notes } = setup();
        take.noteOn('k60', 'C4', 1, ['a', 'b'], 0);
        take.noteOn('k64', 'E4', 1, ['a', 'b'], 0.1);
        take.noteOff('k60', ['a', 'b'], 2);
        take.noteOn('k67', 'G4', 1, ['a'], 1.5);
        take.noteOff('k64', ['a', 'b'], 3);
        take.noteOff('k67', ['a'], 4);
        expect(notes('a').map((note) => `${note.note}@${note.start}+${note.length}`)).toEqual(['C4@0+2', 'E4@0.1+2.9', 'G4@1.5+2.5']);
        expect(notes('b').map((note) => `${note.note}@${note.start}+${note.length}`)).toEqual(['C4@0+2', 'E4@0.1+2.9']);
    });

    it('holds notes under the sustain pedal until the pedal comes up', () => {
        const { take, notes } = setup();
        take.sustain(true, ['a'], 0);
        take.noteOn('k60', 'C4', 1, ['a'], 1);
        take.noteOff('k60', ['a'], 2);
        expect(notes('a')).toEqual([]);
        take.noteOn('k62', 'D4', 1, ['a'], 3);
        take.sustain(false, ['a'], 5);
        // At the pedal-up the released key closes; the key still held stays open.
        expect(notes('a')).toEqual([{ note: 'C4', start: 1, length: 4, velocity: 1 }]);
        take.noteOff('k62', ['a'], 6);
        expect(notes('a')[1]).toEqual({ note: 'D4', start: 3, length: 3, velocity: 1 });
    });

    it('knows a pedal that was down before the take began', () => {
        const tracks = new Map([['a', Object.assign(new NotePattern(16), { id: 'a' })]]);
        const take = new Take({ track: (id) => tracks.get(id), position: (_id, step) => step % 16, pedalDown: ['a'] });
        take.noteOn('k60', 'C4', 1, ['a'], 1);
        take.noteOff('k60', ['a'], 2);
        expect(tracks.get('a')!.notes).toHaveLength(0);
        take.sustain(false, ['a'], 3);
        expect(tracks.get('a')!.notes[0]).toMatchObject({ start: 1, length: 2 });
    });

    it('a key struck again under the pedal ends the old note where the new one starts', () => {
        const { take, notes } = setup();
        take.sustain(true, ['a'], 0);
        take.noteOn('k60', 'C4', 1, ['a'], 1);
        take.noteOff('k60', ['a'], 1.5);
        take.noteOn('k60', 'C4', 0.5, ['a'], 2);
        take.sustain(false, ['a'], 4);
        take.noteOff('k60', ['a'], 5);
        expect(notes('a')).toEqual([
            { note: 'C4', start: 1, length: 1, velocity: 1 },
            { note: 'C4', start: 2, length: 3, velocity: 0.5 },
        ]);
    });

    it('stop closes every open note at the stop', () => {
        const { take, notes } = setup();
        take.noteOn('k60', 'C4', 1, ['a'], 1);
        take.sustain(true, ['b'], 1);
        take.noteOn('k62', 'D4', 1, ['b'], 2);
        take.noteOff('k62', ['b'], 2.5);
        take.stop(6.5);
        expect(notes('a')).toEqual([{ note: 'C4', start: 1, length: 5.5, velocity: 1 }]);
        expect(notes('b')).toEqual([{ note: 'D4', start: 2, length: 4.5, velocity: 1 }]);
        expect(take.openCount).toBe(0);
    });

    it('a note held across the loop end keeps its full length: its tail rings across the wrap', () => {
        const { take, notes } = setup();
        // Pressed on step 14 of the second pass (running step 30), released 5 steps later, after the wrap.
        take.noteOn('k60', 'C4', 1, ['a'], 30);
        take.noteOff('k60', ['a'], 35);
        expect(notes('a')).toEqual([{ note: 'C4', start: 14, length: 5, velocity: 1 }]);
    });

    it('a note played where the track is not playing is heard but not recorded', () => {
        const { take, notes, stopPlaying } = setup();
        stopPlaying();
        take.noteOn('k60', 'C4', 1, ['a'], 3);
        take.noteOff('k60', ['a'], 4);
        take.noteOn('k62', 'D4', 1, ['a'], null);
        take.stop(5);
        expect(notes('a')).toEqual([]);
    });

    it('never makes a note shorter than the shortest there is', () => {
        const { take, tracks } = setup();
        take.noteOn('k60', 'C4', 1, ['a'], 3);
        take.noteOff('k60', ['a'], 3);
        expect(tracks.get('a')!.notes[0]!.length).toBeGreaterThan(0);
    });
});

describe('replace', () => {
    it('clears the notes starting in a step, except the ones the take recorded', () => {
        const pattern = new NotePattern(16);
        const [keep, gone, other, own] = pattern.addNotes([
            { note: 'C4', start: 2.9, length: 1 },
            { note: 'D4', start: 3, length: 1 },
            { note: 'E4', start: 3.99, length: 1 },
            { note: 'F4', start: 3.5, length: 1 },
        ]);
        expect(notesToReplace(pattern.notes, 3, new Set([own!.id])).sort()).toEqual([gone!.id, other!.id].sort());
        expect(keep).toBeDefined();
    });

    it('clears every step once, the first time it is played; then the take overdubs', () => {
        const pass = new ReplacePass(4);
        expect(pass.claim(2)).toBe(true);
        expect(pass.claim(2)).toBe(false);
        expect(pass.claim(3)).toBe(true);
        expect(pass.clearedSteps()).toEqual([2, 3]);
        expect(pass.isDone).toBe(false);
        expect(pass.claim(0)).toBe(true);
        expect(pass.claim(1)).toBe(true);
        expect(pass.isDone).toBe(true);
        expect(pass.claim(7)).toBe(false);
    });

    it('clears the stretch of a recorded lane, keeping the take own points', () => {
        const own = { step: 3.25, value: 0.5 };
        const points: AutomationPoint[] = [{ step: 0, value: 0.1 }, { step: 3, value: 0.2 }, own, { step: 3.9, value: 0.3 }, { step: 4, value: 0.4 }];
        clearLaneStep(points, 3, (point) => point === own);
        expect(points.map((point) => point.step)).toEqual([0, 3.25, 4]);
    });
});

describe('controller thinning', () => {
    it('keeps a value only when it moved by more than 0.5 % and at least 1/64 step passed', () => {
        const thinner = new ControllerThinner<string>();
        expect(thinner.offer(0, 0.5, 'a')).toBe(true);
        // Too soon (under 1/64 step).
        expect(thinner.offer(0.01, 0.6, 'b')).toBe(false);
        // Too small a move.
        expect(thinner.offer(0.5, 0.504, 'c')).toBe(false);
        expect(thinner.offer(0.52, 0.61, 'd')).toBe(true);
    });

    it('keeps at most 16 points per step', () => {
        const thinner = new ControllerThinner<number>();
        let kept = 0;
        for (let i = 0; i < 64; i++) {
            if (thinner.offer(2 + i / 64, i / 64, i)) {
                kept++;
            }
        }
        expect(kept).toBe(CC_MAX_PER_STEP);
        // The next step starts a new count.
        expect(thinner.offer(3, 0.01, 99)).toBe(true);
    });

    it('hands back the final value when it was dropped, once', () => {
        const thinner = new ControllerThinner<string>();
        thinner.offer(0, 0.2, 'first');
        thinner.offer(0.001, 0.9, 'last');
        expect(thinner.flush()).toBe('last');
        expect(thinner.flush()).toBeNull();
        // A value back where the last kept point is leaves nothing to say.
        thinner.offer(1, 0.5, 'kept');
        thinner.offer(1.001, 0.7, 'dropped');
        thinner.offer(1.002, 0.501, 'back');
        expect(thinner.flush()).toBeNull();
    });
});

describe('writing recorded points', () => {
    it('inserts in order and replaces a point on the same step', () => {
        const points: AutomationPoint[] = [{ step: 0, value: 0 }, { step: 4, value: 1 }];
        writeRecordedPoint(points, { step: 2.5, value: 0.3 }, null, () => false);
        writeRecordedPoint(points, { step: 4, value: 0.7 }, null, () => false);
        expect(points).toEqual([
            { step: 0, value: 0 },
            { step: 2.5, value: 0.3 },
            { step: 4, value: 0.7 },
        ]);
    });

    it('a gesture writes over the old curve between its points, also across the loop end', () => {
        const old = (step: number) => ({ step, value: 0.9 });
        const points: AutomationPoint[] = [old(0), old(1), old(2), old(3), old(14), old(15)];
        const mine: AutomationPoint[] = [];
        const isOwn = (point: AutomationPoint) => mine.includes(point);
        const write = (step: number, from: number | null) => mine.push(writeRecordedPoint(points, { step, value: 0.1 }, from, isOwn));
        write(13.5, null);
        write(15.5, 13.5);
        write(1.5, 15.5);
        expect(points.map((point) => `${point.step}:${point.value}`)).toEqual(['1.5:0.1', '2:0.9', '3:0.9', '13.5:0.1', '15.5:0.1']);
        expect(inStretch(0.5, 15.5, 1.5)).toBe(true);
        expect(inStretch(8, 15.5, 1.5)).toBe(false);
    });
});

describe('sub-step automation points', () => {
    it('finds the first point inside a step window, so the step callback schedules those between steps', () => {
        const points: AutomationPoint[] = [0, 1, 1.25, 1.5, 2, 3.75].map((step) => ({ step, value: 0 }));
        expect(firstPointAfter(points, 1)).toBe(2);
        expect(firstPointAfter(points, 0.5)).toBe(1);
        expect(firstPointAfter(points, 3)).toBe(5);
        expect(firstPointAfter(points, 4)).toBe(6);
        expect(firstPointAfter([], 0)).toBe(0);
        // The window (1, 2): the points at 1.25 and 1.5; the one at 2 belongs to the next step.
        const inside: number[] = [];
        for (let i = firstPointAfter(points, 1); i < points.length && points[i]!.step < 2; i++) {
            inside.push(points[i]!.step);
        }
        expect(inside).toEqual([1.25, 1.5]);
    });
});
