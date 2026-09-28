/**
 * Browser checks for MIDI recording (Phase 4 of notes/midi-recording.md), with the fake Web MIDI of `fakeMidi.mjs`.
 *
 *     node scripts/midi/record.mjs [--url http://juicyloops.test/app] [--headed]
 *
 * Runs against the dev server (it imports the app's modules); a server with HMR reloads the page when a source file
 * changes mid-run, so use one started with `server.hmr: false`. Chromium with the plain-http origin treated as secure,
 * so the Rust synth runs (samplers play through Tone either way).
 *
 * Timing: a key is "pressed" at a known musical position. The script waits until that moment has been heard (by the
 * context's output stamp), then sends the message stamped with the performance time at which the output was at that
 * position (a real MIDI message also carries the time it arrived, a moment before it is dispatched). The expected
 * pattern position is derived from the fake's time stamp and `getOutputTimestamp()` read at the send; the recorded
 * start must match within ±3 ms.
 *
 * Checks: loop and song mode takes with a synth and a sampler, overdub, replace, count-in, the metronome (heard at
 * the destination, absent from an offline export), undo of a whole take, controller recording into a lane that plays
 * back in an offline render, pitch-wheel recording, a note held across the loop end, the R key and the button; the
 * selected track playing beside an armed one without recording (a selection change under a held key, nothing armed:
 * the selected track records); in song
 * mode, controllers mapped to the master, a container bus and a track that is not armed record into song automation
 * lanes (thinned, at the song steps heard, the old lane silenced while it records, one undo step), while in loop mode
 * they are only played. Recording into an existing lane (a track's step lane and a song lane) leaves the old curve as
 * it was right up to the gesture and after it: the lane's values and an offline render match the ones before the take.
 * Exit code 1 when a check fails.
 */
import { createRequire } from 'node:module';
import { installFakeMidi } from './fakeMidi.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
};
const url = option('url', 'http://juicyloops.test/app');
const headed = args.includes('--headed');
const { hostname, origin } = new URL(url);

const results = [];
const check = (pass, name, detail = '') => {
    results.push({ pass: pass ? 'ok' : 'FAIL', check: name, detail: String(detail) });
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` · ${detail}`}`);
    if (!pass) {
        process.exitCode = 1;
    }
};

const BPM = 120;
const STEP_MS = 60000 / BPM / 4;
const TOLERANCE_MS = 3;

/* ---- in-page helpers: self-contained, serialized into the page ---- */

/** Taps everything that connects straight to a context's destination (installed before the app loads). */
function destinationTap() {
    const connect = AudioNode.prototype.connect;
    const taps = new WeakMap();
    window.__destinationSources = [];
    window.__destinationTap = (context) => taps.get(context);
    AudioNode.prototype.connect = function (destination, ...rest) {
        const result = connect.call(this, destination, ...rest);
        if (typeof AudioDestinationNode !== 'undefined' && destination instanceof AudioDestinationNode) {
            let tap = taps.get(destination.context);
            if (!tap) {
                tap = destination.context.createAnalyser();
                tap.fftSize = 1024;
                taps.set(destination.context, tap);
            }
            connect.call(this, tap);
            window.__destinationSources.push(this.constructor.name);
        }
        return result;
    };
}

async function installHelpers(bpm) {
    const load = (path) => {
        const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path);
        return import(loaded ? loaded.name : path);
    };
    const { useJuicyLoops } = await load('/src/composables/useJuicyLoops.ts');
    const { useWorkspace } = await load('/src/composables/useWorkspace.ts');
    const { useHistory } = await load('/src/composables/useHistory.ts');
    const { useMidi } = await load('/src/composables/useMidi.ts');
    const { useRecorder } = await load('/src/composables/useRecorder.ts');
    const { midiNoteName } = await load('/src/juicyloops/midi/messages.ts');
    const { renderSession } = await load('/src/juicyloops/render.ts');
    const { valueAt } = await load('/src/juicyloops/automation.ts');
    const jl = useJuicyLoops();
    const recorder = useRecorder();
    const midi = useMidi();
    const history = useHistory();
    const transport = jl.engine.transport;
    const raw = transport.context.rawContext;
    const native = raw._nativeAudioContext ?? raw._nativeContext;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    jl.setBpm(bpm);
    const stepSeconds = 15 / bpm;
    const stamp = () => native.getOutputTimestamp();
    const heardNow = () => {
        const s = stamp();
        return s.contextTime + (performance.now() - s.performanceTime) / 1000;
    };
    const stepOfTime = (time) => transport.getTicksAtTime(time) / (transport.PPQ / 4);

    /** Context time of a running step of the current take. */
    const timeOfStep = (step) => {
        const start = recorder.takeStart();
        return start.time + (step - start.step) * stepSeconds;
    };

    /** Waits until running step `step` has been heard, then sends `bytes` stamped with the moment it was heard. */
    const at = async (step, bytes) => {
        const target = timeOfStep(step);
        while (heardNow() < target + 0.003) {
            await sleep(1);
        }
        const before = stamp();
        const timeStamp = before.performanceTime + (target - before.contextTime) * 1000;
        window.__fakeMidi.send(bytes, null, timeStamp);
        const after = stamp();
        // What the fake's time stamp maps to by the output stamp read at the send.
        const heard = before.contextTime + (timeStamp - before.performanceTime) / 1000;
        return { step, timeStamp, expectedStep: stepOfTime(heard), stampMoved: after.contextTime !== before.contextTime };
    };

    /** Plays `events` ([step, bytes]) in order at their steps. */
    const perform = async (events) => {
        const sent = [];
        for (const [step, bytes] of events) {
            sent.push(await at(step, bytes));
        }
        return sent;
    };

    /** Waits until `step` of the take was heard. */
    const until = async (step) => {
        const target = timeOfStep(step);
        while (heardNow() < target) {
            await sleep(2);
        }
    };

    const trackById = (id) => {
        for (const container of jl.containers.value) {
            const track = container.tracks.find((candidate) => candidate.id === id);
            if (track) {
                return track;
            }
        }
        return null;
    };
    const notesOf = (id) => trackById(id).notes.map((note) => ({ note: note.note, start: note.start, length: note.length, velocity: note.velocity }));
    const armOnly = (ids) => {
        for (const container of jl.containers.value) {
            for (const track of container.tracks) {
                track.setArmed(ids.includes(track.id));
            }
        }
    };

    /** Peak of what reaches the destination (tap) over `ms`, polled. */
    const destinationPeak = async (ms) => {
        const tap = window.__destinationTap(native);
        const data = new Float32Array(tap.fftSize);
        let peak = 0;
        const peaks = [];
        const until = performance.now() + ms;
        while (performance.now() < until) {
            tap.getFloatTimeDomainData(data);
            let p = 0;
            for (let i = 0; i < data.length; i++) {
                p = Math.max(p, Math.abs(data[i]));
            }
            peaks.push([Math.round(performance.now()), p]);
            peak = Math.max(peak, p);
            await sleep(8);
        }
        return { peak, peaks };
    };

    /** Offline render of a container, one pass (or of the song, with `containerId` null): RMS per window and the onsets (silence to sound). */
    const render = async (containerId, repeats = 1) => {
        const scope = containerId ? { kind: 'container', containerId, repeats } : { kind: 'song' };
        const audio = await renderSession(jl.engine.capture(), { bpm, scope, tail: 0.3, sampleRate: 44100 });
        const data = audio.getChannelData(0);
        const rate = audio.sampleRate;
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
            peak = Math.max(peak, Math.abs(data[i]));
        }
        const rms = (fromSec, toSec) => {
            let sum = 0;
            const from = Math.round(fromSec * rate);
            const to = Math.min(data.length, Math.round(toSec * rate));
            for (let i = from; i < to; i++) {
                sum += data[i] * data[i];
            }
            return Math.sqrt(sum / Math.max(1, to - from));
        };
        const onsets = [];
        let quiet = 0;
        for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > 1e-3) {
                if (quiet > rate * 0.02 || (i > 0 && onsets.length === 0 && quiet === i)) {
                    onsets.push(i / rate);
                }
                quiet = 0;
            } else {
                quiet++;
            }
        }
        return { peak, onsets, rms: (a, b) => rms(a, b), duration: audio.duration, window: (fromStep, toStep) => rms(fromStep * stepSeconds, toStep * stepSeconds) };
    };

    /**
     * How far a lane's curve strays from `old` (points) outside a recorded gesture: before `first` (its first point) and
     * after `last` (its last), sampled every 1/16 step up to 1/128 step from the gesture, and at the hold 1/256 step
     * (half a millisecond) before it, where the recording takes over.
     */
    const curveDrift = (points, old, first, last, end) => {
        const samples = [first - 1 / 256];
        for (let step = 0; step < first - 1 / 128; step += 1 / 16) {
            samples.push(step);
        }
        for (let step = last + 1 / 128; step < end; step += 1 / 16) {
            samples.push(step);
        }
        let worst = 0;
        let at = null;
        for (const step of samples) {
            const drift = Math.abs(valueAt(points, step) - valueAt(old, step));
            if (drift > worst) {
                worst = drift;
                at = step;
            }
        }
        return { worst, at };
    };

    window.__jlr = { jl, recorder, midi, history, workspace: useWorkspace(), midiNoteName, transport, native, sleep, stepSeconds, heardNow, perform, at, until, notesOf, trackById, armOnly, destinationPeak, render, stepOfTime, valueAt, curveDrift };
}

/* ---- node side ---- */

const evaluate = (page, fn, arg) => page.evaluate(fn, arg);

const addTrack = (page, type, { length = 16, containerId = null } = {}) =>
    evaluate(
        page,
        async ([kind, steps, container]) => {
            const { jl } = window.__jlr;
            const target = container ? jl.containers.value.find((candidate) => candidate.id === container) : jl.currentContainer.value;
            const created = jl.addTrack(kind, target);
            const track = target.tracks.find((candidate) => candidate.id === created.id);
            track.setLength(steps);
            if (kind === 'synth') {
                track.setEnvelope('attack', 0.001);
                track.setEnvelope('sustain', 1);
                track.setEnvelope('release', 0.02);
            }
            await track.whenReady();
            return { id: track.id, containerId: target.id, engine: track.engine?.constructor.name ?? null };
        },
        [type, length, containerId],
    );

const settle = (page, ms = 700) => page.waitForTimeout(ms);

/** Recorded starts vs what was played: the largest error in ms, and a readable list. */
const compareStarts = (recorded, expected) => {
    const errors = expected.map((want, i) => (recorded[i] === undefined ? Infinity : Math.abs(recorded[i] - want) * STEP_MS));
    return { worst: Math.max(...errors), detail: expected.map((want, i) => `${want.toFixed(3)}→${recorded[i]?.toFixed(4) ?? '-'} (${errors[i].toFixed(2)} ms)`).join(', ') };
};

const setSettings = (page, settings) => evaluate(page, (values) => Object.assign(window.__jlr.recorder.settings, values), settings);

const main = async () => {
    const browser = await chromium.launch({
        channel: 'chromium',
        headless: !headed,
        args: [
            '--autoplay-policy=no-user-gesture-required',
            `--unsafely-treat-insecure-origin-as-secure=${origin}`,
            ...(hostname.endsWith('.test') ? [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`] : []),
        ],
    });
    try {
        const page = await browser.newPage();
        page.on('pageerror', (error) => console.error('[page error]', error.message));
        if (process.env.JL_DEBUG) {
            page.on('console', (message) => console.log('[console]', message.text().slice(0, 300)));
        }
        await installFakeMidi(page);
        await page.addInitScript(destinationTap);
        await page.addInitScript(() => localStorage.removeItem('juicyloops:record'));
        await page.goto(url, { waitUntil: 'load' });
        await page.locator('.modecard[data-mode="pro"]').click({ timeout: 60000 });
        await page.waitForFunction(() => !document.querySelector('.welcome'));
        await evaluate(page, installHelpers, BPM);
        await evaluate(page, () => window.__jlr.midi.enable());

        /* ---- defaults, the button, the R key ---- */
        const defaults = await evaluate(page, () => ({ ...window.__jlr.recorder.settings }));
        check(defaults.countIn && defaults.metronome && !defaults.replace && !defaults.metronomeWhilePlaying && defaults.offsetMs === 0, 'defaults: overdub, count-in and metronome on', JSON.stringify(defaults));
        check((await page.locator('.recordbtn').count()) === 1, 'the Record button sits in the transport');

        const synth = await addTrack(page, 'synth');
        check(synth.engine === 'SynthVoices', 'synth runs the Rust engine', synth.engine);
        await evaluate(page, (id) => window.__jlr.armOnly([id]), synth.id);
        await setSettings(page, { countIn: false, metronome: false });
        await page.keyboard.press('r');
        await page.waitForTimeout(300);
        const byKey = await evaluate(page, () => ({ state: window.__jlr.recorder.state.value, playing: window.__jlr.jl.isPlaying.value }));
        check(byKey.state === 'recording' && byKey.playing, 'R starts recording and playback', JSON.stringify(byKey));
        await page.keyboard.press('r');
        const punched = await evaluate(page, () => ({ state: window.__jlr.recorder.state.value, playing: window.__jlr.jl.isPlaying.value }));
        check(punched.state === 'off' && punched.playing, 'R again stops recording, playback goes on', JSON.stringify(punched));
        await page.locator('.recordbtn').click();
        const byButton = await evaluate(page, () => window.__jlr.recorder.state.value);
        check(byButton === 'recording', 'the button punches in while playing', byButton);
        await evaluate(page, () => window.__jlr.jl.stop());
        const stopped = await evaluate(page, () => ({ state: window.__jlr.recorder.state.value, notes: window.__jlr.jl.tracks.value[0].notes.length }));
        check(stopped.state === 'off' && stopped.notes === 0, 'stop ends the take; nothing played, nothing recorded', JSON.stringify(stopped));
        await settle(page);

        /* ---- loop mode: four notes at known times (synth) ---- */
        const revisionBefore = await evaluate(page, () => window.__jlr.history.revision.value);
        const loopTake = await evaluate(
            page,
            async ({ id }) => {
                const { recorder, perform, until, jl, notesOf, midiNoteName } = window.__jlr;
                recorder.record();
                const sent = await perform([
                    [1, [0x90, 60, 100]],
                    [2, [0x80, 60, 0]],
                    [4.5, [0x90, 64, 90]],
                    [6.5, [0x80, 64, 0]],
                    [8.25, [0x90, 67, 127]],
                    [8.75, [0x80, 67, 0]],
                    [12.75, [0x90, 72, 64]],
                    [14, [0x80, 72, 0]],
                ]);
                await until(15);
                jl.stop();
                return { sent, notes: notesOf(id), names: [60, 64, 67, 72].map(midiNoteName) };
            },
            synth,
        );
        const ons = loopTake.sent.filter((_, i) => i % 2 === 0);
        const starts = loopTake.notes.map((note) => note.start);
        const intended = compareStarts(starts, [1, 4.5, 8.25, 12.75]);
        const byStamp = compareStarts(
            starts,
            ons.map((sent) => sent.expectedStep % 16),
        );
        check(loopTake.notes.length === 4, 'loop: four notes recorded', JSON.stringify(loopTake.notes.map((note) => note.note)));
        check(
            byStamp.worst <= TOLERANCE_MS,
            'loop: starts match the fake time stamps mapped by getOutputTimestamp (±3 ms)',
            `${byStamp.detail}; the output stamp moved during ${ons.filter((sent) => sent.stampMoved).length} of 4 sends`,
        );
        check(intended.worst <= TOLERANCE_MS, 'loop: starts land where they were played (±3 ms)', intended.detail);
        const lengths = compareStarts(
            loopTake.notes.map((note) => note.length),
            [1, 2, 0.5, 1.25],
        );
        check(lengths.worst <= TOLERANCE_MS * 2, 'loop: lengths are what was held', lengths.detail);
        check(JSON.stringify(loopTake.notes.map((note) => note.note)) === JSON.stringify(loopTake.names), 'loop: note names are what the keys play (midiNoteName)', loopTake.names.join(' '));
        check(
            loopTake.notes.map((note) => Math.round(note.velocity * 127)).join() === '100,90,127,64',
            'loop: velocities kept',
            loopTake.notes.map((note) => note.velocity.toFixed(3)).join(' '),
        );
        await settle(page);
        const revisionAfter = await evaluate(page, () => window.__jlr.history.revision.value);
        check(revisionAfter - revisionBefore === 1, 'loop: the take is one undo step', `${revisionAfter - revisionBefore} history entries`);

        // The recorded notes play at their positions: onsets of an offline render.
        const rendered = await evaluate(page, async (containerId) => {
            const result = await window.__jlr.render(containerId);
            return { onsets: result.onsets, peak: result.peak };
        }, synth.containerId);
        const onsetSteps = rendered.onsets.map((seconds) => (seconds * 1000) / STEP_MS);
        const playback = compareStarts(onsetSteps, starts);
        check(playback.worst <= 1.5, 'loop: an offline render plays the recorded notes at their starts', playback.detail);

        /* ---- overdub ---- */
        const overdub = await evaluate(
            page,
            async ({ id }) => {
                const { recorder, perform, until, jl, notesOf } = window.__jlr;
                recorder.record();
                await perform([
                    [3, [0x90, 62, 100]],
                    [3.5, [0x80, 62, 0]],
                    [16 + 10, [0x90, 65, 100]],
                    [16 + 11, [0x80, 65, 0]],
                ]);
                await until(28);
                jl.stop();
                return notesOf(id);
            },
            synth,
        );
        check(
            overdub.length === 6 && [3, 10].every((step) => overdub.some((note) => Math.abs(note.start - step) * STEP_MS <= TOLERANCE_MS)),
            'overdub: two more notes (one on the second pass), the four stay',
            overdub.map((note) => `${note.note}@${note.start.toFixed(3)}`).join(' '),
        );
        await settle(page);

        /* ---- replace ---- */
        await setSettings(page, { replace: true });
        const replaced = await evaluate(
            page,
            async ({ id }) => {
                const { recorder, perform, until, jl, notesOf } = window.__jlr;
                recorder.record();
                // First pass: one note; the pass clears everything it plays over.
                await perform([
                    [5, [0x90, 69, 100]],
                    [6, [0x80, 69, 0]],
                ]);
                await until(16 + 1);
                const afterFirstPass = notesOf(id);
                // Second pass overdubs.
                await perform([
                    [16 + 9, [0x90, 71, 100]],
                    [16 + 9.5, [0x80, 71, 0]],
                ]);
                await until(16 + 12);
                jl.stop();
                return { afterFirstPass, final: notesOf(id) };
            },
            synth,
        );
        check(
            replaced.afterFirstPass.length === 1 && Math.abs(replaced.afterFirstPass[0].start - 5) * STEP_MS <= TOLERANCE_MS,
            'replace: the first pass clears what it passed and keeps the new note',
            replaced.afterFirstPass.map((note) => `${note.note}@${note.start.toFixed(3)}`).join(' '),
        );
        check(replaced.final.length === 2, 'replace: the second pass overdubs', replaced.final.map((note) => `${note.note}@${note.start.toFixed(3)}`).join(' '));
        await settle(page);
        await setSettings(page, { replace: false });

        /* ---- undo takes back whole takes ---- */
        const undone = await evaluate(page, (id) => {
            const { history, notesOf } = window.__jlr;
            const counts = [notesOf(id).length];
            history.undo();
            counts.push(notesOf(id).length);
            history.undo();
            counts.push(notesOf(id).length);
            history.undo();
            counts.push(notesOf(id).length);
            return counts;
        }, synth.id);
        check(undone.join() === '2,6,4,0', 'undo removes one whole take at a time (replace, overdub, first take)', `notes: ${undone.join(' → ')}`);

        /* ---- a note held across the loop end ---- */
        const held = await evaluate(
            page,
            async ({ id }) => {
                const { recorder, perform, until, jl, notesOf } = window.__jlr;
                recorder.record();
                await perform([
                    [14, [0x90, 60, 100]],
                    [19, [0x80, 60, 0]],
                ]);
                await until(20);
                jl.stop();
                return notesOf(id);
            },
            synth,
        );
        check(
            held.length === 1 && Math.abs(held[0].start - 14) * STEP_MS <= TOLERANCE_MS && Math.abs(held[0].length - 5) * STEP_MS <= TOLERANCE_MS * 2,
            'a note held across the loop end keeps its length',
            held.map((note) => `start ${note.start.toFixed(4)} length ${note.length.toFixed(4)}`).join(),
        );
        const heldRender = await evaluate(page, async (containerId) => {
            const result = await window.__jlr.render(containerId, 2);
            // Two passes: the note of the first pass rings from step 14 across the wrap into steps 16..19.
            return { tail: result.window(16 + 1, 16 + 2.5), gap: result.window(16 + 4, 16 + 12) };
        }, synth.containerId);
        check(heldRender.tail > 0.01 && heldRender.gap < 1e-4, 'its tail rings across the wrap in a render', `rms steps 17..18.5 ${heldRender.tail.toFixed(4)}, steps 20..28 ${heldRender.gap.toExponential(1)}`);
        await settle(page);
        await evaluate(page, (id) => window.__jlr.trackById(id).clear(), synth.id);
        await settle(page);

        /* ---- sustain pedal ---- */
        const pedal = await evaluate(
            page,
            async ({ id }) => {
                const { recorder, perform, until, jl, notesOf } = window.__jlr;
                recorder.record();
                await perform([
                    [1, [0xb0, 64, 127]],
                    [2, [0x90, 60, 100]],
                    [3, [0x80, 60, 0]],
                    [6, [0xb0, 64, 0]],
                ]);
                await until(7);
                jl.stop();
                return notesOf(id);
            },
            synth,
        );
        check(pedal.length === 1 && Math.abs(pedal[0].length - 4) * STEP_MS <= TOLERANCE_MS * 2, 'sustain: a note released under the pedal lasts until the pedal-up', pedal.map((note) => note.length.toFixed(4)).join());
        await settle(page);
        await evaluate(page, (id) => window.__jlr.trackById(id).clear(), synth.id);
        await settle(page);

        /* ---- controller recording into a lane, pitch wheel ---- */
        const cc = await evaluate(
            page,
            async ({ id, containerId }) => {
                const { recorder, perform, until, jl, trackById, stepSeconds } = window.__jlr;
                const track = trackById(id);
                // A note that holds through the whole pattern, so the level is heard all the time.
                track.addNote({ note: 'A4', start: 0, length: 15.9, velocity: 1 });
                jl.engine.sequencer.setMidiMappings([{ cc: 74, channel: 'all', target: { kind: 'track', containerId, trackId: id }, param: 'volume' }]);
                recorder.record();
                // A sweep from the bottom (step 1) to the top (step 7), 32 messages a step (a dense controller).
                const events = [];
                for (let i = 0; i <= 192; i++) {
                    events.push([1 + i / 32, [0xb0, 74, Math.round((i / 192) * 127)]]);
                }
                // The wheel, on the same track (a synth): up and back.
                events.push([9, [0xe0, 0x7f, 0x7f]], [10, [0xe0, 0x00, 0x40]]);
                await perform(events);
                await until(12);
                jl.stop();
                const lane = track.automation.laneFor('volume');
                const bend = track.automation.laneFor('bend');
                const perStep = new Map();
                for (const point of lane?.points ?? []) {
                    const step = Math.floor(point.step);
                    perStep.set(step, (perStep.get(step) ?? 0) + 1);
                }
                return {
                    points: lane ? lane.points.map((point) => [+point.step.toFixed(3), +point.value.toFixed(3)]) : null,
                    fractional: lane ? lane.points.filter((point) => point.step % 1 !== 0).length : 0,
                    maxPerStep: Math.max(0, ...perStep.values()),
                    bend: bend ? bend.points.map((point) => [+point.step.toFixed(3), +point.value.toFixed(3)]) : null,
                    stepSeconds,
                };
            },
            synth,
        );
        check(!!cc.points && cc.points.length >= 10, 'CC: a learned controller aimed at the armed track records into its volume lane', cc.points ? `${cc.points.length} points, ${cc.fractional} between steps` : 'no lane');
        check(cc.maxPerStep <= 16 && cc.points.length < 100, 'CC: thinned (at most 16 a step, fewer points than messages)', `max ${cc.maxPerStep} per step, ${cc.points?.length} points from 193 messages`);
        const first = cc.points?.[0];
        check(first && first[0] === 0 && first[1] > 0.8, 'CC: the lane holds the level the take began with before the first move', JSON.stringify(cc.points?.slice(0, 3)));
        check(!!cc.bend && cc.bend.some(([, value]) => value > 0.95) && cc.bend.some(([step, value]) => step > 9.5 && Math.abs(value - 0.5) < 0.01), 'bend: the wheel records into the bend lane (up, back to centre)', JSON.stringify(cc.bend));
        const ccRender = await evaluate(page, async (containerId) => {
            const result = await window.__jlr.render(containerId);
            return [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 8.5].map((step) => result.window(step, step + 0.5));
        }, synth.containerId);
        const db = ccRender.map((rms) => 20 * Math.log10(Math.max(rms, 1e-9)));
        const rising = db.slice(1, 7).every((value, i, all) => i === 0 || value > all[i - 1]);
        check(db[1] < db[7] - 25 && rising, 'CC: the lane plays back, the level follows the sweep in an offline render', db.map((value) => value.toFixed(1)).join(' dB, ') + ' dB');
        await settle(page);
        await evaluate(page, (id) => {
            const { jl, trackById } = window.__jlr;
            const track = trackById(id);
            track.clear();
            for (const lane of [...track.automation.lanes]) {
                track.automation.remove(lane.id);
            }
            track.settleAll();
            track.setVolume(0);
            jl.engine.sequencer.setMidiMappings([]);
        }, synth.id);
        await settle(page);

        /* ---- a controller into an existing step lane: the old curve stays up to the gesture and after it ---- */
        const trackHold = await evaluate(
            page,
            async ({ id, containerId }) => {
                const { recorder, perform, until, jl, trackById, render, curveDrift } = window.__jlr;
                const track = trackById(id);
                track.addNote({ note: 'A4', start: 0, length: 15.9, velocity: 1 });
                // An existing volume lane rising from -26 dB (step 0) to +1 dB (step 15).
                const lane = track.automation.add('volume', 0.3);
                lane.points.push({ step: 15, value: 0.9 });
                const old = lane.points.map((point) => ({ ...point }));
                const windows = [0.5, 2.5, 4.5, 6.5, 7.5, 12.25, 13.5, 14.5];
                const measure = async () => {
                    const result = await render(containerId);
                    return windows.map((step) => 20 * Math.log10(Math.max(result.window(step, step + 0.4), 1e-9)));
                };
                const before = await measure();
                jl.engine.sequencer.setMidiMappings([{ cc: 74, channel: 'all', target: { kind: 'track', containerId, trackId: id }, param: 'volume' }]);
                recorder.record();
                // A gesture from the top (step 8) down to the bottom (step 11).
                const events = [];
                for (let i = 0; i <= 96; i++) {
                    events.push([8 + i / 32, [0xb0, 74, Math.round((1 - i / 96) * 127)]]);
                }
                await perform(events);
                await until(12.5);
                jl.stop();
                const first = lane.points.find((point) => point.step >= 7.99 && point.value > 0.95);
                const last = [...lane.points].reverse().find((point) => point.step <= 11.1 && point.value < 0.05);
                const drift = first && last ? curveDrift(lane.points, old, first.step, last.step, 16) : null;
                const after = await measure();
                return {
                    before,
                    after,
                    drift,
                    first: first ? [first.step, first.value] : null,
                    last: last ? [last.step, last.value] : null,
                    around: lane.points.filter((point) => point.step > 7 && point.step < 8.1).map((point) => [+point.step.toFixed(4), +point.value.toFixed(3), point.shape ?? null]),
                };
            },
            synth,
        );
        check(
            !!trackHold.drift && trackHold.drift.worst < 1e-6 && trackHold.first[0] < 8.05 && trackHold.last[0] > 10.9,
            'CC into an existing step lane: the old curve is unchanged right up to the gesture (8) and after it (11)',
            trackHold.drift ? `worst drift ${trackHold.drift.worst.toExponential(1)} at step ${trackHold.drift.at?.toFixed(3)}; around the start ${JSON.stringify(trackHold.around)}` : 'no gesture found',
        );
        const trackDbDrift = trackHold.before.map((db, i) => Math.abs(db - trackHold.after[i]));
        check(
            Math.max(...trackDbDrift) < 0.5,
            'CC into an existing step lane: an offline render matches the old curve before and after the gesture',
            `before ${trackHold.before.map((db) => db.toFixed(1)).join(', ')} dB; after ${trackHold.after.map((db) => db.toFixed(1)).join(', ')} dB (steps 0.5..7.5, 12.25..14.5)`,
        );
        await evaluate(page, (id) => {
            const { jl, trackById } = window.__jlr;
            const track = trackById(id);
            track.clear();
            for (const lane of [...track.automation.lanes]) {
                track.automation.remove(lane.id);
            }
            track.settleAll();
            track.setVolume(0);
            jl.engine.sequencer.setMidiMappings([]);
        }, synth.id);
        await settle(page);

        /* ---- the selected track plays live; only the armed ones record (or the selected one when none is) ---- */
        const other = await addTrack(page, 'synth');
        const split = await evaluate(
            page,
            async ({ armed, selected }) => {
                const { recorder, perform, until, jl, notesOf, trackById, armOnly, workspace, sleep } = window.__jlr;
                const counts = () => [trackById(armed).liveNoteCount, trackById(selected).liveNoteCount];
                armOnly([armed]);
                workspace.selectTrack(selected);
                recorder.record();
                await perform([[1, [0x90, 60, 100]]]);
                const whileHeld = counts();
                await perform([
                    [2, [0x80, 60, 0]],
                    [4, [0x90, 64, 100]],
                ]);
                // The selection moves while the key is held: the note-off still reaches both tracks it plays on.
                workspace.selectTrack(armed);
                const afterSelect = counts();
                await perform([[5.5, [0x80, 64, 0]]]);
                const afterRelease = counts();
                await until(6.5);
                jl.stop();
                const armedTake = { armed: notesOf(armed), selected: notesOf(selected) };
                await sleep(700);
                // Nothing armed: the selected track records, as before.
                armOnly([]);
                workspace.selectTrack(selected);
                recorder.record();
                await perform([
                    [1, [0x90, 67, 100]],
                    [2, [0x80, 67, 0]],
                ]);
                await until(3);
                jl.stop();
                const selectedTake = { armed: notesOf(armed), selected: notesOf(selected) };
                return { whileHeld, afterSelect, afterRelease, armedTake, selectedTake };
            },
            { armed: synth.id, selected: other.id },
        );
        const describeNotes = (notes) => notes.map((note) => `${note.note}@${note.start.toFixed(2)}+${note.length.toFixed(2)}`).join(' ') || 'none';
        check(split.whileHeld.join() === '1,1', 'armed A + selected B: a key sounds on both', `live notes A ${split.whileHeld[0]}, B ${split.whileHeld[1]}`);
        check(
            split.armedTake.armed.length === 2 && split.armedTake.selected.length === 0,
            'armed A + selected B: only A records',
            `A: ${describeNotes(split.armedTake.armed)}; B: ${describeNotes(split.armedTake.selected)}`,
        );
        const moved = split.armedTake.armed.find((note) => note.note === 'E4');
        check(
            split.afterSelect.join() === '1,1' && split.afterRelease.join() === '0,0' && !!moved && Math.abs(moved.length - 1.5) * STEP_MS <= TOLERANCE_MS * 2,
            'a selection change during a held note: the note-off releases it on both tracks, A records its full length',
            `held ${split.afterSelect.join('/')}, after the note-off ${split.afterRelease.join('/')}; recorded ${moved ? moved.length.toFixed(3) : '-'} steps`,
        );
        check(
            split.selectedTake.selected.length === 1 && split.selectedTake.selected[0].note === 'G4' && split.selectedTake.armed.length === 2,
            'nothing armed: the selected track records',
            `B: ${describeNotes(split.selectedTake.selected)}; A unchanged (${split.selectedTake.armed.length})`,
        );
        await evaluate(
            page,
            ({ armed, selected }) => {
                const { jl, trackById, armOnly, workspace } = window.__jlr;
                trackById(armed).clear();
                jl.removeTrack(selected);
                armOnly([armed]);
                workspace.selectTrack(armed);
            },
            { armed: synth.id, selected: other.id },
        );
        await settle(page);

        /* ---- count-in and the metronome ---- */
        await setSettings(page, { countIn: true, metronome: true });
        const countIn = await evaluate(page, async () => {
            const { recorder, transport, native, jl, destinationPeak, sleep } = window.__jlr;
            const clock = transport._clock;
            const pressed = native.currentTime;
            recorder.record();
            const state = recorder.state.value;
            const start = recorder.takeStart().time;
            const bar = (60 / jl.bpm.value) * 4;
            const before = clock.getStateAtTime(start - 0.01);
            const after = clock.getStateAtTime(start + 0.01);
            const heard = await destinationPeak(bar * 1000 + 300);
            await sleep(200);
            const later = recorder.state.value;
            jl.stop();
            return { delay: start - pressed, bar, state, later, before, after, peak: heard.peak, clicks: heard.peaks.filter(([, p], i, all) => p > 0.1 && (i === 0 || all[i - 1][1] <= 0.1)).length };
        });
        check(countIn.state === 'countin' && countIn.later === 'recording', 'count-in: counts in, then records', `${countIn.state} → ${countIn.later}`);
        check(
            countIn.before === 'stopped' && countIn.after === 'started' && Math.abs(countIn.delay - countIn.bar - 0.1) < 0.005,
            'count-in: the transport starts one bar after the press',
            `start ${countIn.delay.toFixed(3)} s after the press (bar ${countIn.bar.toFixed(3)} s + 0.1 s lead), ${countIn.before} → ${countIn.after}`,
        );
        check(countIn.clicks >= 4, 'count-in: the clicks are heard at the destination', `${countIn.clicks} clicks, peak ${countIn.peak.toFixed(3)}`);
        await settle(page);

        const metronome = await evaluate(page, async (containerId) => {
            const { recorder, jl, destinationPeak, render, sleep } = window.__jlr;
            Object.assign(recorder.settings, { metronomeWhilePlaying: true });
            // The master all the way down: whatever is heard does not come through it.
            const master = jl.engine.master;
            const level = master.getParameter('volume');
            master.setParameter('volume', master.parameter('volume').min);
            jl.play();
            await sleep(300);
            const live = await destinationPeak(1200);
            jl.stop();
            await sleep(300);
            Object.assign(recorder.settings, { metronomeWhilePlaying: false });
            jl.play();
            await sleep(300);
            const off = await destinationPeak(1200);
            jl.stop();
            master.setParameter('volume', level);
            Object.assign(recorder.settings, { metronomeWhilePlaying: true });
            const exported = await render(containerId);
            Object.assign(recorder.settings, { metronomeWhilePlaying: false });
            return { live: live.peak, off: off.peak, exported: exported.peak, sources: [...new Set(window.__destinationSources)] };
        }, synth.containerId);
        check(metronome.live > 0.1, 'metronome while playing: clicks at the destination with the master all the way down', `peak ${metronome.live.toFixed(3)}; nodes feeding the destination: ${metronome.sources.join(', ')}`);
        check(metronome.off < 1e-3, 'metronome off: silence', `peak ${metronome.off.toExponential(1)}`);
        check(metronome.exported === 0, 'metronome: absent from an offline export (an empty pattern renders silent)', `peak ${metronome.exported}`);
        await setSettings(page, { countIn: false, metronome: false });

        /* ---- sampler, loop mode ---- */
        const sampler = await evaluate(page, async () => {
            const { jl } = window.__jlr;
            const rate = 44100;
            const perSlice = Math.round(rate * 0.4);
            const frequencies = [220, 330, 440, 660];
            const buffer = new ArrayBuffer(44 + perSlice * 4 * 2);
            const view = new DataView(buffer);
            const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
            text(0, 'RIFF');
            view.setUint32(4, 36 + perSlice * 8, true);
            text(8, 'WAVE');
            text(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, rate, true);
            view.setUint32(28, rate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            text(36, 'data');
            view.setUint32(40, perSlice * 8, true);
            for (let i = 0; i < perSlice * 4; i++) {
                view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * frequencies[Math.floor(i / perSlice)] * (i % perSlice)) / rate) * 0.5 * 32767), true);
            }
            const created = jl.addTrack('sampler');
            const track = jl.tracks.value.find((candidate) => candidate.id === created.id);
            track.setLength(16);
            await track.loadSample(new Blob([buffer], { type: 'audio/wav' }), 'slices.wav');
            track.sliceEvenly(4);
            await track.whenReady();
            return { id: track.id, containerId: jl.currentContainer.value.id };
        });
        await evaluate(page, (id) => window.__jlr.armOnly([id]), sampler.id);
        const samplerTake = await evaluate(
            page,
            async ({ id }) => {
                const { recorder, perform, until, jl, notesOf, midiNoteName } = window.__jlr;
                recorder.record();
                const sent = await perform([
                    [2, [0x90, 72, 127]],
                    [2.5, [0x80, 72, 0]],
                    [5.75, [0x90, 73, 127]],
                    [6.25, [0x80, 73, 0]],
                    [9.625, [0x90, 74, 127]],
                    [10, [0x80, 74, 0]],
                    [13.5, [0x90, 75, 127]],
                    [14, [0x80, 75, 0]],
                ]);
                await until(15);
                jl.stop();
                return { sent, notes: notesOf(id), names: [72, 73, 74, 75].map(midiNoteName) };
            },
            sampler,
        );
        const samplerStarts = samplerTake.notes.map((note) => note.start);
        const samplerErrors = compareStarts(
            samplerStarts,
            samplerTake.sent.filter((_, i) => i % 2 === 0).map((sent) => sent.expectedStep % 16),
        );
        check(samplerTake.notes.length === 4 && samplerErrors.worst <= TOLERANCE_MS, 'sampler, loop: four notes at the stamped times (±3 ms)', samplerErrors.detail);
        check(JSON.stringify(samplerTake.notes.map((note) => note.note)) === JSON.stringify(samplerTake.names), 'sampler: keys 72..75 record the slices they play', samplerTake.notes.map((note) => note.note).join(' '));
        const samplerRender = await evaluate(page, async (containerId) => (await window.__jlr.render(containerId)).onsets, sampler.containerId);
        const samplerPlayback = compareStarts(
            samplerRender.map((seconds) => (seconds * 1000) / STEP_MS),
            samplerStarts,
        );
        check(samplerPlayback.worst <= 1.5, 'sampler: an offline render plays them at their starts', samplerPlayback.detail);
        await settle(page);

        /* ---- song mode ---- */
        const songSetup = await evaluate(page, async () => {
            const { jl } = window.__jlr;
            const first = jl.currentContainer.value.id;
            const container = jl.addContainer();
            jl.selectContainer(first);
            const song = jl.song.value;
            song.addClip(song.lanes[0].id, container.id, 16, 32);
            return { containerId: container.id };
        });
        const songSynth = await addTrack(page, 'synth', { containerId: songSetup.containerId });
        await evaluate(page, (id) => window.__jlr.armOnly([id]), songSynth.id);
        const songTake = await evaluate(
            page,
            async ({ id }) => {
                const { recorder, perform, until, jl, notesOf } = window.__jlr;
                jl.setMode('song');
                jl.cueSong(0);
                recorder.record();
                const sent = await perform([
                    // Before the clip: heard, not recorded.
                    [8, [0x90, 60, 100]],
                    [9, [0x80, 60, 0]],
                    [20, [0x90, 62, 100]],
                    [21, [0x80, 62, 0]],
                    [26.5, [0x90, 64, 100]],
                    [27, [0x80, 64, 0]],
                    [33.25, [0x90, 65, 100]],
                    [34, [0x80, 65, 0]],
                    [40.75, [0x90, 67, 100]],
                    [41.5, [0x80, 67, 0]],
                ]);
                await until(42);
                jl.stop();
                jl.setMode('loop');
                return { sent, notes: notesOf(id) };
            },
            songSynth,
        );
        // Clip at song step 16, the track is 16 steps long: song step s plays pattern step (s - 16) mod 16.
        const songExpected = songTake.sent.filter((_, i) => i % 2 === 0 && i > 0).map((sent) => (((sent.expectedStep - 16) % 16) + 16) % 16);
        const songStarts = [...songTake.notes].map((note) => note.start);
        const songErrors = compareStarts(
            songStarts,
            [...songExpected].sort((a, b) => a - b),
        );
        check(songTake.notes.length === 4, 'song: notes before the clip are not recorded, the four in it are', songTake.notes.map((note) => `${note.note}@${note.start.toFixed(3)}`).join(' '));
        check(songErrors.worst <= TOLERANCE_MS, 'song: starts at the clip-relative pattern position of the stamped times (±3 ms)', songErrors.detail);
        await settle(page);

        /* ---- song mode: controllers into song automation lanes ---- */
        const songCc = await evaluate(
            page,
            async ({ armed, unarmed, containerId }) => {
                const { recorder, perform, until, jl, trackById, history, heardNow, sleep, workspace } = window.__jlr;
                // The unarmed track is the selected one: it plays live, but is no record target while another is armed.
                workspace.selectTrack(unarmed.id);
                const song = jl.song.value;
                const sequencer = jl.engine.sequencer;
                const master = sequencer.master;
                const armedTrack = trackById(armed.id);
                armedTrack.clear();
                // A tone through every pass of the clip (song steps 16..48), so the master's level is heard all the time.
                armedTrack.addNote({ note: 'A4', start: 0, length: 15.9, velocity: 1 });
                // An existing master lane (-17 dB, falling to -40 dB at step 30): the take records into it and silences it meanwhile.
                const old = song.addAutomation({ kind: 'master' }, 'volume');
                old.points.push({ step: 0, value: 0.5 }, { step: 30, value: 0 });
                const oldPoints = JSON.stringify(old.points);
                sequencer.setMidiMappings([
                    { cc: 20, channel: 'all', target: { kind: 'master' }, param: 'volume' },
                    { cc: 21, channel: 'all', target: { kind: 'container', containerId }, param: 'volume' },
                    { cc: 22, channel: 'all', target: { kind: 'track', containerId: unarmed.containerId, trackId: unarmed.id }, param: 'volume' },
                    { cc: 23, channel: 'all', target: { kind: 'track', containerId, trackId: armed.id }, param: 'pan' },
                ]);
                history.commit();
                const lanesBefore = song.automation.length;
                const revisionBefore = history.revision.value;
                const busStart = sequencer.resolveTarget({ kind: 'container', containerId }).getParameter('volume');
                // The song editor is open, so the lanes can be seen arriving (the song view plays in song mode).
                await document.querySelector('#app').__vue_app__.config.globalProperties.$router.push({ name: 'app.song' });
                await sleep(500);
                jl.setMode('song');
                jl.cueSong(0);
                recorder.record();
                const sweep = (cc, from, to, up) => {
                    const events = [];
                    for (let i = 0; i <= 192; i++) {
                        const t = i / 192;
                        events.push([from + t * (to - from), [0xb0, cc, Math.round((up ? t : 1 - t) * 127)]]);
                    }
                    return events;
                };
                // The bus before the clip (nothing plays there: the song lane records anyway), the master inside it.
                await perform([...sweep(21, 4, 10, true), ...sweep(20, 20, 26, true)]);
                await until(29);
                await sleep(30);
                const rowsDuring = document.querySelectorAll('.arr-row--auto').length;
                const heldDuring = sequencer.heldSongLanes.size;
                // After the sweep (it ends at +6 dB on step 26) the old lane would pull the master down towards its point at
                // step 30 (-28 dB at step 29); held, the controller's +6 dB stays.
                const liveMasterDb = master.output.volume.getValueAtTime(heardNow());
                await perform([...sweep(22, 29, 31, false), ...sweep(23, 32, 34, true)]);
                await until(36);
                jl.stop();
                await sleep(50);
                const rowsAfter = document.querySelectorAll('.arr-row--auto').length;
                const lanes = song.automation.map((lane) => ({
                    id: lane.id,
                    target: { ...lane.target },
                    param: lane.param,
                    points: lane.points.map((point) => [point.step, +point.value.toFixed(4), point.shape ?? null]),
                }));
                return {
                    lanes,
                    oldId: old.id,
                    oldPoints,
                    lanesBefore,
                    busStart,
                    heldDuring,
                    rowsDuring,
                    rowsAfter,
                    heldAfter: sequencer.heldSongLanes.size,
                    liveMasterDb,
                    entries: history.revision.value - revisionBefore,
                    armedPan: armedTrack.automation.laneFor('pan')?.points.length ?? 0,
                    armedPanPositions: (armedTrack.automation.laneFor('pan')?.points ?? []).map((point) => +point.step.toFixed(3)),
                };
            },
            { armed: songSynth, unarmed: synth, containerId: songSetup.containerId },
        );
        const laneOf = (kind, param) => songCc.lanes.find((lane) => lane.target.kind === kind && lane.param === param);
        const masterLane = laneOf('master', 'volume');
        const busLane = laneOf('container', 'volume');
        const trackLane = laneOf('track', 'volume');
        // The recorded points of a gesture, without the holds 1/256 step before (shape `hold`) and after it (recorded
        // points are 1/64 step apart at least).
        const holdGap = (a, b) => !!a && !!b && Math.abs(b[0] - a[0] - 1 / 256) < 1e-9;
        const isHold = (points, i) => (points[i][2] === 'hold' && holdGap(points[i], points[i + 1])) || (holdGap(points[i - 1], points[i]) && points[i - 1][2] !== 'hold');
        const recordedOf = (lane, from, to) => (lane ? lane.points.filter(([step], i, points) => step >= from - 0.01 && step <= to + 0.05 && !isHold(points, i)) : []);
        const maxPerStep = (points) => {
            const perStep = new Map();
            for (const [step] of points) {
                perStep.set(Math.floor(step), (perStep.get(Math.floor(step)) ?? 0) + 1);
            }
            return Math.max(0, ...perStep.values());
        };
        const masterPoints = recordedOf(masterLane, 20, 26);
        const busPoints = recordedOf(busLane, 4, 10);
        const trackPoints = recordedOf(trackLane, 29, 31);
        check(
            songCc.lanes.length === songCc.lanesBefore + 2 && masterLane?.id === songCc.oldId && !!busLane && !!trackLane && !laneOf('track', 'pan'),
            'song CC: master, bus and unarmed (selected) track controllers record into song lanes (the existing master lane is reused)',
            songCc.lanes.map((lane) => `${lane.target.kind}.${lane.param} (${lane.points.length})`).join(', '),
        );
        const thinned = [masterPoints, busPoints, trackPoints].every((points) => points.length >= 10 && points.length < 100 && maxPerStep(points) <= 16);
        check(thinned, 'song CC: thinned points (at most 16 a step, fewer than the 193 messages each)', [masterPoints, busPoints, trackPoints].map((points) => `${points.length} pts, max ${maxPerStep(points)}/step`).join('; '));
        const onSweep = (points, from, to, up) =>
            points.length > 0 &&
            Math.abs(points[0][0] - from) < 0.05 &&
            Math.abs(points.at(-1)[0] - to) < 0.1 &&
            points.every(([step, value]) => Math.abs(value - (up ? (step - from) / (to - from) : 1 - (step - from) / (to - from))) < 0.03);
        check(
            onSweep(masterPoints, 20, 26, true) && onSweep(busPoints, 4, 10, true) && onSweep(trackPoints, 29, 31, false),
            'song CC: points at the song steps heard (master 20..26, bus 4..10 before the clip, track 29..31)',
            [masterPoints, busPoints, trackPoints].map((points) => `${points[0]?.[0].toFixed(3)}/${points[0]?.[1]} … ${points.at(-1)?.[0].toFixed(3)}/${points.at(-1)?.[1]}`).join('; '),
        );
        const busFirst = busLane?.points[0];
        check(
            !!busFirst && busFirst[0] === 0 && busFirst[2] === 'hold' && Math.abs(busFirst[1] - (songCc.busStart + 40) / 46) < 0.01 && trackLane?.points[0]?.[2] === 'hold',
            'song CC: a new lane holds the value the take began with until the first move',
            JSON.stringify(busLane?.points.slice(0, 2)),
        );
        const masterOld = masterLane?.points.filter(([step]) => step === 0 || step === 30) ?? [];
        check(masterOld.length === 2, 'song CC: the existing lane keeps its points outside the gesture', JSON.stringify(masterLane?.points.filter(([step]) => step < 20 || step > 26.1)));
        check(
            songCc.armedPan >= 10 && songCc.armedPanPositions.every((step) => step >= 0 && step < 16.001),
            'song CC: a controller aimed at the armed track still records into its step lane (clip-relative)',
            `${songCc.armedPan} points, ${songCc.armedPanPositions[0]}..${songCc.armedPanPositions.at(-1)}`,
        );
        check(
            songCc.rowsDuring === songCc.lanesBefore + 1 && songCc.rowsAfter === songCc.lanesBefore + 2,
            'song CC: the song editor shows the new lanes while recording and after',
            `rows: ${songCc.lanesBefore} before, ${songCc.rowsDuring} during (after the bus sweep), ${songCc.rowsAfter} after`,
        );
        check(songCc.heldDuring >= 2 && songCc.heldAfter === 0, 'song CC: the lanes being recorded are silenced while the take runs, and play again after', `held during ${songCc.heldDuring}, after ${songCc.heldAfter}`);
        check(songCc.liveMasterDb > 3, 'song CC: the controller is heard, not the old lane (master at the controller value after the sweep)', `${songCc.liveMasterDb.toFixed(1)} dB at step 29 (the lane: -28 dB)`);
        check(songCc.entries === 1, 'song CC: the take is one undo step', `${songCc.entries} history entries`);
        const songRender = await evaluate(page, async () => {
            const result = await window.__jlr.render(null);
            return [20.25, 21, 22, 23, 24, 25, 25.75].map((step) => result.window(step, step + 0.25));
        });
        const songDb = songRender.map((rms) => 20 * Math.log10(Math.max(rms, 1e-9)));
        const songRising = songDb.every((value, i, all) => i === 0 || value > all[i - 1] - 0.5);
        check(
            songRising && songDb[5] - songDb[0] > 20,
            'song CC: an offline render of the song follows the recorded master sweep',
            songDb.map((value) => value.toFixed(1)).join(' dB, ') + ' dB (steps 20.25, 21..25, 25.75)',
        );
        const songUndo = await evaluate(page, (oldId) => {
            const { history, jl } = window.__jlr;
            history.undo();
            const song = jl.song.value;
            return {
                lanes: song.automation.map((lane) => ({ id: lane.id, points: JSON.stringify(lane.points) })),
                pan: jl.containers.value.flatMap((container) => container.tracks).some((track) => track.automation.laneFor('pan')),
                oldId,
            };
        }, songCc.oldId);
        check(
            songUndo.lanes.length === songCc.lanesBefore && songUndo.lanes.find((lane) => lane.id === songCc.oldId)?.points === songCc.oldPoints && !songUndo.pan,
            'song CC: undo removes the recorded points and the lanes the take made',
            songUndo.lanes.map((lane) => `${lane.id === songCc.oldId ? 'master' : lane.id}: ${lane.points}`).join('; '),
        );
        await settle(page);

        /* ---- a controller into an existing song lane: the old curve stays up to the gesture and after it ---- */
        const songHold = await evaluate(page, async () => {
            const { recorder, perform, until, jl, render, curveDrift, history } = window.__jlr;
            const song = jl.song.value;
            // The master lane of before (-17 dB at step 0, falling to -40 dB at step 30), the tone in the clip (16..48).
            const lane = song.automation.find((candidate) => candidate.target.kind === 'master' && candidate.param === 'volume');
            const old = lane.points.map((point) => ({ ...point }));
            const windows = [16.25, 18, 20, 21.5, 25.5, 27, 29];
            const measure = async () => {
                const result = await render(null);
                return windows.map((step) => 20 * Math.log10(Math.max(result.window(step, step + 0.4), 1e-9)));
            };
            const before = await measure();
            const revisionBefore = history.revision.value;
            jl.setMode('song');
            jl.cueSong(0);
            recorder.record();
            // A gesture from the bottom (step 22) to the top (step 25).
            const events = [];
            for (let i = 0; i <= 96; i++) {
                events.push([22 + i / 32, [0xb0, 20, Math.round((i / 96) * 127)]]);
            }
            await perform(events);
            await until(26);
            jl.stop();
            const first = lane.points.find((point) => point.step >= 21.99 && point.step < 22.1 && point.value < 0.05);
            const last = [...lane.points].reverse().find((point) => point.step <= 25.1 && point.value > 0.95);
            const drift = first && last ? curveDrift(lane.points, old, first.step, last.step, 40) : null;
            const after = await measure();
            const around = lane.points.filter((point) => (point.step > 21 && point.step < 22.1) || (point.step > 24.9 && point.step < 26)).map((point) => [+point.step.toFixed(4), +point.value.toFixed(3), point.shape ?? null]);
            const entries = history.revision.value - revisionBefore;
            // Leave the song as it was.
            history.undo();
            return { before, after, drift, first: first ? [first.step, first.value] : null, last: last ? [last.step, last.value] : null, around, entries, restored: JSON.stringify(lane.points) === JSON.stringify(old) };
        });
        check(
            !!songHold.drift && songHold.drift.worst < 1e-6 && songHold.first[0] < 22.05 && songHold.last[0] > 24.9,
            'CC into an existing song lane: the old curve is unchanged right up to the gesture (22) and after it (25)',
            songHold.drift ? `worst drift ${songHold.drift.worst.toExponential(1)} at step ${songHold.drift.at?.toFixed(3)}; around the ends ${JSON.stringify(songHold.around)}` : 'no gesture found',
        );
        const songDbDrift = songHold.before.map((db, i) => Math.abs(db - songHold.after[i]));
        check(
            Math.max(...songDbDrift) < 0.5 && songHold.entries === 1 && songHold.restored,
            'CC into an existing song lane: an offline render of the song matches the old curve before and after the gesture',
            `before ${songHold.before.map((db) => db.toFixed(1)).join(', ')} dB; after ${songHold.after.map((db) => db.toFixed(1)).join(', ')} dB (steps 16.25..21.5, 25.5..29); undone: ${songHold.restored}`,
        );
        await settle(page);

        /* ---- loop mode: the same controllers are played, not recorded ---- */
        const loopCc = await evaluate(page, async () => {
            const { recorder, perform, until, jl } = window.__jlr;
            const song = jl.song.value;
            const before = JSON.stringify(song.automation);
            const masterBefore = jl.engine.sequencer.master.getParameter('volume');
            await document.querySelector('#app').__vue_app__.config.globalProperties.$router.push({ name: 'app.index' });
            await window.__jlr.sleep(300);
            jl.setMode('loop');
            recorder.record();
            const events = [];
            for (let i = 0; i <= 64; i++) {
                events.push([2 + i / 16, [0xb0, 20, Math.round((i / 64) * 127)]], [2 + i / 16, [0xb0, 21, Math.round((i / 64) * 127)]]);
            }
            await perform(events);
            await until(7);
            jl.stop();
            return { same: JSON.stringify(song.automation) === before, masterBefore, masterAfter: jl.engine.sequencer.master.getParameter('volume') };
        });
        check(loopCc.same && loopCc.masterAfter !== loopCc.masterBefore, 'loop mode: controllers of the master and a bus are played live, song lanes stay untouched', JSON.stringify(loopCc));
    } finally {
        await browser.close();
    }
    const failed = results.filter((result) => result.pass !== 'ok').length;
    console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
