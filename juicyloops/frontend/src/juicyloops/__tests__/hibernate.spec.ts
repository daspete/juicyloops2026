import { describe, expect, it, vi } from 'vitest';
import { Effects } from '../effects/effects';
import { Hibernation, markDue, MIN_TAIL, TAIL_MARGIN, upcomingSegments, WAKE_WINDOW_STEPS, type Sleeper } from '../hibernate';
import { Song } from '../song';

/* jsdom has no Web Audio: the compressor is a stand-in, enough for a rack to create, wire and dispose it. */
vi.mock('tone', async (importOriginal) => {
    const tone = await importOriginal<typeof import('tone')>();
    class FakeDynamics {
        readonly context = { currentTime: 0 };
        readonly threshold = { value: 0 };
        readonly ratio = { value: 0 };
        readonly attack = { value: 0 };
        readonly release = { value: 0 };
        disconnect() {}
        dispose() {}
    }
    return { ...tone, Compressor: FakeDynamics, Limiter: FakeDynamics };
});

/** A container that only records when it slept and woke, with a fixed tail. */
class FakeContainer implements Sleeper {
    isAwake = true;
    readonly events: string[] = [];
    step = 0;

    constructor(
        readonly id: string,
        private readonly seconds = 0,
    ) {}

    sleep(): void {
        this.isAwake = false;
        this.events.push(`sleep@${this.step}`);
    }

    wake(): void {
        this.isAwake = true;
        this.events.push(`wake@${this.step}`);
    }

    tail(): number {
        return this.seconds;
    }
}

/** A step at 120 bpm; a power of two, so the times add up exactly. */
const STEP_SECONDS = 0.125;

/** Plays a song from step `from` to `to` in song mode the way the sequencer does, and returns what every container did. */
const playSong = (song: Song, containers: FakeContainer[], from: number, to: number, hibernation = new Hibernation()) => {
    const window: number[] = [0, 0, 0, 0];
    const due = new Set<string>();
    for (let step = from; step < to; step++) {
        containers.forEach((container) => (container.step = step));
        const count = upcomingSegments(step % song.length, WAKE_WINDOW_STEPS, 0, song.length, window);
        due.clear();
        markDue(song, window, count, due);
        hibernation.update(containers, due, step * STEP_SECONDS, () => STEP_SECONDS);
        // Whatever plays at this step must be awake by now.
        for (const id of song.playingAt(step % song.length).keys()) {
            expect(containers.find((container) => container.id === id)!.isAwake, `${id} at step ${step}`).toBe(true);
        }
    }
    return hibernation;
};

/** The step a container with this tail may sleep at, after it stops being due at `lastDue + 1`. */
const sleepStep = (lastDue: number, tail: number) => lastDue + 1 + Math.ceil((Math.max(MIN_TAIL, tail) + TAIL_MARGIN) / STEP_SECONDS);

describe('upcomingSegments', () => {
    it('covers the window in one piece when it does not reach the wrap point', () => {
        const into = [0, 0, 0, 0];
        expect(upcomingSegments(10, 32, 0, 128, into)).toBe(1);
        expect(into.slice(0, 2)).toEqual([10, 42]);
    });

    it('wraps to the start of the song or loop region', () => {
        const into = [0, 0, 0, 0];
        expect(upcomingSegments(120, 32, 0, 128, into)).toBe(2);
        expect(into).toEqual([120, 128, 0, 24]);

        expect(upcomingSegments(60, 32, 48, 64, into)).toBe(2);
        // A loop region shorter than the window is covered whole.
        expect(into).toEqual([60, 64, 48, 64]);
    });
});

describe('markDue', () => {
    it('finds containers whose clips overlap the window, skipping muted clips and lanes silenced by a solo', () => {
        const song = new Song(3);
        const [one, two, three] = song.lanes;
        song.addClip(one!.id, 'a', 0, 16);
        song.addClip(one!.id, 'b', 64, 16);
        const muted = song.addClip(two!.id, 'c', 16, 16)!;
        muted.isMuted = true;
        song.addClip(three!.id, 'd', 36, 8);

        const window = [0, 0, 0, 0];
        const due = new Set<string>();
        markDue(song, window, upcomingSegments(8, WAKE_WINDOW_STEPS, 0, song.length, window), due);
        expect([...due].sort()).toEqual(['a', 'd']);

        three!.isSolo = true;
        due.clear();
        markDue(song, window, upcomingSegments(8, WAKE_WINDOW_STEPS, 0, song.length, window), due);
        expect([...due]).toEqual(['d']);
    });
});

describe('Hibernation', () => {
    it('wakes a container a window ahead of its clip and puts it to sleep once its tail has rung out', () => {
        // A plays bars 1-2, B only after a long gap, from step 96 to 128. The song is 160 steps long.
        const song = new Song();
        const lane = song.lanes[0]!;
        song.addClip(lane.id, 'a', 0, 32);
        song.addClip(lane.id, 'b', 96, 32);
        song.addClip(lane.id, 'c', 144, 16);
        const a = new FakeContainer('a', 2);
        const b = new FakeContainer('b', 0.3);
        const c = new FakeContainer('c');
        const idle = new FakeContainer('idle');

        playSong(song, [a, b, c, idle], 0, 160);

        // Nothing is due for B and C yet at the start, nothing ever for `idle`: asleep right away.
        expect(idle.events).toEqual(['sleep@0']);
        expect(b.events[0]).toBe('sleep@0');
        // A was due up to step 31, then rings for its 2 s tail (plus the margin) before it sleeps.
        // The song loops: once the window reaches past its end, A is due again at its top.
        expect(a.events).toEqual([`sleep@${sleepStep(31, 2)}`, `wake@${160 - WAKE_WINDOW_STEPS + 1}`]);
        // B wakes when its clip enters the two-bar window, and its short tail is stretched to the minimum.
        expect(b.events).toEqual(['sleep@0', `wake@${96 - WAKE_WINDOW_STEPS + 1}`, `sleep@${sleepStep(127, 0.3)}`]);
        expect(c.events).toEqual(['sleep@0', `wake@${144 - WAKE_WINDOW_STEPS + 1}`]);
        expect(a.isAwake).toBe(true);
    });

    it('takes the tail when a container stops being due, from the values it has then', () => {
        const container = new FakeContainer('a', 3);
        const hibernation = new Hibernation();
        const due = new Set(['a']);
        hibernation.update([container], due, 0, () => STEP_SECONDS);
        due.clear();
        hibernation.update([container], due, 1, () => STEP_SECONDS);
        hibernation.update([container], due, 1 + 3 + TAIL_MARGIN - STEP_SECONDS, () => STEP_SECONDS);
        expect(container.isAwake).toBe(true);
        hibernation.update([container], due, 1 + 3 + TAIL_MARGIN, () => STEP_SECONDS);
        expect(container.isAwake).toBe(false);
    });

    it('keeps a container woken from outside (a container switch, a seek) until it has rung out', () => {
        const old = new FakeContainer('old', 0);
        const next = new FakeContainer('next', 0);
        next.isAwake = false;
        const hibernation = new Hibernation();
        const due = new Set(['old']);
        hibernation.update([old, next], due, 0, () => STEP_SECONDS);

        // Loop mode switches to `next`: it wakes on the spot, `old` stays until its tail is over.
        hibernation.wake(next);
        expect(next.isAwake).toBe(true);
        due.clear();
        due.add('next');
        hibernation.update([old, next], due, 0.125, () => STEP_SECONDS);
        expect(old.isAwake).toBe(true);
        hibernation.update([old, next], due, 0.125 + MIN_TAIL + TAIL_MARGIN, () => STEP_SECONDS);
        expect(old.isAwake).toBe(false);
        expect(next.isAwake).toBe(true);
    });
});

describe('Effects.suspend', () => {
    it('keeps every value, builds no node while suspended and builds the needed ones again on resume', () => {
        const rack = new Effects({ role: 'bus' });
        rack.setParam('compressor', 'ratio', 4);
        expect(rack.isActive('compressor')).toBe(true);

        rack.suspend();
        expect(rack.isActive('compressor')).toBe(false);
        rack.setParam('compressor', 'ratio', 6);
        rack.setParameter('fx.compressor.threshold', -30, 1);
        expect(rack.isActive('compressor')).toBe(false);
        expect(rack.getParam('compressor', 'ratio')).toBe(6);
        expect(rack.isNeeded('compressor')).toBe(true);

        rack.resume();
        expect(rack.isActive('compressor')).toBe(true);
        rack.dispose();
    });

    it('reports a tail for the reverb and the delay, whether or not their nodes exist', () => {
        const rack = new Effects();
        rack.suspend();
        expect(rack.tail()).toBe(0);
        rack.setParam('reverb', 'wet', 0.3);
        rack.setParams('reverb', { decay: 4, preDelay: 0.1 });
        expect(rack.tail()).toBeCloseTo(4.1);
        rack.setParam('delay', 'wet', 0.2);
        rack.setParam('delay', 'delayTime', 0.5);
        // Tone's default feedback of 0.125 dies away to -60 dB in four repeats.
        expect(rack.tail()).toBeCloseTo(4.1 + 0.5 * 4);
    });
});
