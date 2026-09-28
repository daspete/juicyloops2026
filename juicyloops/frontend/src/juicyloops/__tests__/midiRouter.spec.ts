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
    const router = new MidiRouter({ live: () => armed, now: () => now, wake: (track) => woken.push(track.id) });
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

/**
 * The studio's split: live = armed plus the selected track; record targets = the armed ones, or the selected one when
 * none is armed. The router plays the first and reports the second with every event.
 */
describe('MIDI router: live tracks and record targets', () => {
    const splitSetup = () => {
        const a = fakeTrack('a');
        const b = fakeTrack('b');
        const c = fakeTrack('c');
        let armed: LiveTrack[] = [a.track];
        let selected: LiveTrack | null = b.track;
        const live = () => (selected && !armed.includes(selected) ? [...armed, selected] : armed);
        const recordTargets = () => (armed.length || !selected ? armed : [selected]);
        const router = new MidiRouter({ live, recordTargets, now: () => 1 });
        const events: MidiRouterEvent[] = [];
        router.subscribe((event) => events.push(event));
        const send = (...bytes: number[]) => router.handle('in', parseMidiMessage(bytes)!, 1000);
        return {
            a,
            b,
            c,
            router,
            events,
            send,
            arm: (...tracks: LiveTrack[]) => (armed = tracks),
            select: (track: LiveTrack | null) => (selected = track),
        };
    };

    it('plays the armed tracks and the selected one, but records only the armed ones', () => {
        const { a, b, events, send } = splitSetup();
        send(0x90, 60, 127);
        expect(a.calls).toEqual(['on in:0:60 C4 1.00 @1']);
        expect(b.calls).toEqual(['on in:0:60 C4 1.00 @1']);
        expect(events[0]).toMatchObject({ trackIds: ['a', 'b'], recordTrackIds: ['a'] });
        send(0x80, 60, 0);
        expect(events[1]).toMatchObject({ trackIds: ['a', 'b'], recordTrackIds: ['a'] });
    });

    it('plays a selected track that is armed too only once', () => {
        const { a, events, send, select } = splitSetup();
        select(a.track);
        send(0x90, 60, 127);
        expect(a.calls).toHaveLength(1);
        expect(events[0]).toMatchObject({ trackIds: ['a'], recordTrackIds: ['a'] });
    });

    it('records the selected track when nothing is armed', () => {
        const { a, b, events, send, arm } = splitSetup();
        arm();
        send(0x90, 60, 127);
        expect(a.calls).toEqual([]);
        expect(b.calls).toHaveLength(1);
        expect(events[0]).toMatchObject({ trackIds: ['b'], recordTrackIds: ['b'] });
    });

    it('releases a held note on the track it started on when the selection changes, and closes it where it recorded', () => {
        const { a, b, c, events, send, select } = splitSetup();
        send(0x90, 64, 100);
        select(c.track);
        send(0x80, 64, 0);
        expect(b.calls).toEqual(['on in:0:64 E4 0.79 @1', 'off in:0:64 @1']);
        expect(a.calls[1]).toBe('off in:0:64 @1');
        expect(c.calls).toEqual([]);
        expect(events[1]).toMatchObject({ type: 'noteoff', trackIds: ['a', 'b'], recordTrackIds: ['a'] });
    });

    it('keeps the record targets of a note-on for its note-off, even when arming changed', () => {
        const { a, b, events, send, arm } = splitSetup();
        arm();
        send(0x90, 60, 127);
        arm(a.track);
        send(0x80, 60, 0);
        expect(b.calls[1]).toBe('off in:0:60 @1');
        expect(a.calls).toEqual([]);
        expect(events[1]).toMatchObject({ trackIds: ['b'], recordTrackIds: ['b'] });
    });

    it('reports the pedal, controllers and the wheel to the record targets among the live tracks', () => {
        const { events, send, select, c } = splitSetup();
        send(0xb0, 64, 127);
        select(c.track);
        send(0xb0, 74, 10);
        send(0xe0, 0x7f, 0x7f);
        send(0xb0, 64, 0);
        expect(events.map((event) => [event.type, event.trackIds, event.recordTrackIds])).toEqual([
            ['sustain', ['a', 'b'], ['a']],
            ['cc', ['a', 'c'], ['a']],
            ['bend', ['a', 'c'], ['a']],
            // Pedal-up reaches every track it went down on (b) and the live ones now (c).
            ['sustain', ['a', 'b', 'c'], ['a']],
        ]);
    });

    it('closes the recorded notes on all notes off', () => {
        const { events, router, send } = splitSetup();
        send(0x90, 60, 127);
        router.allNotesOff(0);
        expect(events[1]).toMatchObject({ type: 'allnotesoff', recordTrackIds: ['a'] });
        expect([...events[1]!.trackIds].sort()).toEqual(['a', 'b']);
    });
});
