import { describe, expect, it } from 'vitest';
import { liveNoteId, parseMidiMessage } from '../midi/messages';
import { MidiRouter, type LiveTrack, type MidiRouterEvent } from '../midi/router';

/** A track that writes down what it was asked to do. */
const fakeTrack = (id: string) => {
    const calls: string[] = [];
    const track: LiveTrack = {
        id,
        noteOn: (note, name, velocity, time) => calls.push(`on ${note} ${name} ${velocity.toFixed(2)} @${time}`),
        noteOff: (note, time) => calls.push(`off ${note} @${time}`),
        setSustain: (down, time) => calls.push(`pedal ${down ? 'down' : 'up'} @${time}`),
        setLiveBend: (value, time) => calls.push(`bend ${value.toFixed(2)} @${time}`),
        allNotesOff: (time) => calls.push(`all off @${time}`),
    };
    return { track, calls };
};

const setup = () => {
    const a = fakeTrack('a');
    const b = fakeTrack('b');
    let armed: LiveTrack[] = [a.track];
    let now = 1;
    const woken: string[] = [];
    const router = new MidiRouter({ armed: () => armed, now: () => now, wake: (track) => woken.push(track.id) });
    const events: MidiRouterEvent[] = [];
    router.subscribe((event) => events.push(event));
    const send = (...bytes: number[]) => router.handle('in', parseMidiMessage(bytes)!, 1000 + now);
    return {
        a,
        b,
        router,
        events,
        woken,
        send,
        arm: (...tracks: LiveTrack[]) => (armed = tracks),
        at: (time: number) => (now = time),
    };
};

describe('MIDI router', () => {
    it('plays every armed track, on any channel, at the current context time', () => {
        const { a, b, send, arm, woken } = setup();
        arm(a.track, b.track);
        send(0x95, 60, 127);
        expect(a.calls).toEqual([`on ${liveNoteId('in', 5, 60)} C4 1.00 @1`]);
        expect(b.calls).toEqual([`on ${liveNoteId('in', 5, 60)} C4 1.00 @1`]);
        expect(woken).toEqual(['a', 'b']);
    });

    it('sends a note-off to the tracks its note-on went to, even after arming changed', () => {
        const { a, b, send, arm, at } = setup();
        send(0x90, 62, 100);
        arm(b.track);
        at(2);
        send(0x80, 62, 0);
        expect(a.calls[1]).toBe(`off in:0:62 @2`);
        expect(b.calls).toEqual([]);
    });

    it('lets the pedal up reach the tracks it went down on', () => {
        const { a, b, send, arm } = setup();
        send(0xb0, 64, 127);
        arm(b.track);
        send(0xb0, 64, 0);
        expect(a.calls).toEqual(['pedal down @1', 'pedal up @1']);
        expect(b.calls).toEqual(['pedal up @1']);
    });

    it('bends the armed tracks and brings a disarmed one back to the centre', () => {
        const { a, b, send, arm } = setup();
        send(0xe0, 0x7f, 0x7f);
        arm(b.track);
        send(0xe0, 0x00, 0x40);
        expect(a.calls).toEqual(['bend 1.00 @1', 'bend 0.00 @1']);
        expect(b.calls).toEqual(['bend 0.00 @1']);
    });

    it('stops everything on all notes off, and only one input when it goes away', () => {
        const { a, router, send } = setup();
        send(0x90, 60, 100);
        router.handle('other', parseMidiMessage([0x90, 61, 100])!, 0);
        router.allNotesOff(0, 'other');
        expect(a.calls[a.calls.length - 1]).toBe('all off @1');
        expect(router.heldNotes).toBe(1);
        send(0xb0, 123, 0);
        expect(router.heldNotes).toBe(0);
    });

    it('hands every event to subscribers with its ids, times and tracks (the recorder hook)', () => {
        const { events, send, at } = setup();
        send(0x90, 60, 127);
        at(1.5);
        send(0xb0, 74, 99);
        send(0x80, 60, 0);
        expect(events.map((event) => event.type)).toEqual(['noteon', 'cc', 'noteoff']);
        expect(events[0]).toMatchObject({ id: 'in:0:60', note: 60, velocity: 1, timeStamp: 1001, time: 1, trackIds: ['a'], input: 'in', channel: 0 });
        expect(events[1]).toMatchObject({ cc: 74, value: 99, time: 1.5, trackIds: ['a'] });
        expect(events[2]).toMatchObject({ id: 'in:0:60', trackIds: ['a'] });
    });

    it('plays nothing but still reports a note when no track is armed', () => {
        const { events, send, arm } = setup();
        arm();
        send(0x90, 60, 127);
        send(0x80, 60, 0);
        expect(events.map((event) => event.trackIds)).toEqual([[], []]);
    });
});
