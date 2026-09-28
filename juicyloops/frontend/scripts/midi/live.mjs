/**
 * Browser checks for live MIDI playing (Phase 3 of notes/midi-recording.md), with the fake Web MIDI of `fakeMidi.mjs`.
 *
 *     node scripts/midi/live.mjs [--url http://juicyloops.test/app] [--only rust|tone|latency] [--headed]
 *
 * Runs against the dev server (it imports the app's modules). A server with HMR reloads the page when a source file
 * changes mid-run; a scratch server started with `server.hmr: false` avoids that. The `tone` pass needs an origin
 * that is not localhost (localhost counts as secure): map a `.test` name to 127.0.0.1, which the script does for
 * `.test` hosts. Three passes:
 *  - `rust`: Chromium with the plain-http dev origin treated as secure, so AudioWorklet and the Rust synth run. Checks
 *    the MIDI UI, note-on onset (in frames after the event), note-off, sustain, pitch bend, last-note priority, MIDI
 *    learn (and that a controller gesture is one undo step), the sampler's slices and gate, a sleeping container that
 *    an armed note wakes, and the Tone engine on the same secure page (built with WebAssembly hidden) for comparison.
 *  - `tone`: the headless shell on the insecure origin, where there is no AudioWorklet: synths fall back to Tone.js.
 *    Checked with an AnalyserNode: note-on, note-off, sustain, bend, last-note priority, sampler slices.
 *  - `latency`: event to first non-silent sample, for 'interactive' (the default) and 'balanced' contexts.
 *
 * Exit code 1 when a check fails. Prints a table of results.
 */
import { createRequire } from 'node:module';
import { controlChange, installFakeMidi, noteOff, noteOn, pitchBend, sendMidi, sustain } from './fakeMidi.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
};
const url = option('url', 'http://juicyloops.test/app');
const only = option('only', null);
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

const launch = (secure) =>
    chromium.launch({
        ...(secure ? { channel: 'chromium' } : {}),
        headless: !headed,
        args: [
            '--autoplay-policy=no-user-gesture-required',
            ...(secure ? [`--unsafely-treat-insecure-origin-as-secure=${origin}`] : []),
            ...(hostname.endsWith('.test') ? [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`] : []),
        ],
    });

/** Opens the studio with fake MIDI, clicks through the welcome card and installs the in-page test helpers (`__jlt`). */
const openStudio = async (browser, { lowLatency = true } = {}) => {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[page error]', error.message));
    if (process.env.JL_DEBUG) {
        page.on('console', (message) => console.log('[console]', message.text().slice(0, 300)));
    }
    await installFakeMidi(page);
    await page.addInitScript((low) => localStorage.setItem('juicyloops:lowLatency', String(low)), lowLatency);
    await page.goto(url, { waitUntil: 'load' });
    await page.locator('.modecard[data-mode="pro"]').click({ timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('.welcome'));
    await page.evaluate(installHelpers);
    return page;
};

/* ---- in-page helpers: self-contained, serialized into the page ---- */

async function installHelpers() {
    const load = (path) => {
        const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path);
        return import(loaded ? loaded.name : path);
    };
    const toneEntry = performance.getEntriesByType('resource').find((entry) => entry.name.includes('/deps/tone.js'));
    const Tone = await import(toneEntry.name);
    const { useJuicyLoops } = await load('/src/composables/useJuicyLoops.ts');
    const { useWorkspace } = await load('/src/composables/useWorkspace.ts');
    const { useHistory } = await load('/src/composables/useHistory.ts');
    const { useMidi } = await load('/src/composables/useMidi.ts');
    const jl = useJuicyLoops();
    const context = jl.engine.transport.context;
    const raw = context.rawContext;
    const rate = raw.sampleRate;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /* Taps: a recording worklet (secure contexts) or an analyser (anywhere) on the master bus input. */
    const hasWorklet = raw.audioWorklet !== undefined;
    let tap = null;
    const pending = new Map();
    let nextId = 1;
    if (hasWorklet) {
        const source = `
            class JlTap extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.detect = null;
                    this.capture = null;
                    this.port.onmessage = (event) => {
                        const m = event.data;
                        if (m.type === 'detect') this.detect = m;
                        if (m.type === 'capture') this.capture = { id: m.id, frames: m.frames, buffer: new Float32Array(m.frames), filled: 0, start: -1 };
                        if (m.type === 'ping') this.port.postMessage({ type: 'pong', id: m.id, frame: currentFrame });
                    };
                }
                process(inputs) {
                    const channel = inputs[0] && inputs[0][0];
                    const length = channel ? channel.length : 128;
                    if (this.detect && channel) {
                        for (let i = 0; i < length; i++) {
                            if (Math.abs(channel[i]) > this.detect.threshold) {
                                this.port.postMessage({ type: 'done', id: this.detect.id, frame: currentFrame + i });
                                this.detect = null;
                                break;
                            }
                        }
                    }
                    const c = this.capture;
                    if (c) {
                        if (c.start < 0) c.start = currentFrame;
                        const take = Math.min(length, c.frames - c.filled);
                        if (channel) c.buffer.set(channel.subarray(0, take), c.filled);
                        c.filled += take;
                        if (c.filled >= c.frames) {
                            this.port.postMessage({ type: 'done', id: c.id, start: c.start, data: c.buffer });
                            this.capture = null;
                        }
                    }
                    return true;
                }
            }
            registerProcessor('jl-tap', JlTap);`;
        await context.addAudioWorkletModule(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        tap = context.createAudioWorkletNode('jl-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
        tap.port.onmessage = (event) => {
            pending.get(event.data.id)?.({ ...event.data, receivedAt: performance.now() });
            pending.delete(event.data.id);
        };
    }
    const analyser = raw.createAnalyser();
    analyser.fftSize = 2048;
    /*
     * The taps listen to the master bus input. Rewiring the master rack (an undo restores it) disconnects everything
     * from that node, so they are connected again before every measurement (a repeated connect changes nothing).
     */
    const attach = () => {
        if (tap) {
            Tone.connect(jl.engine.master.input, tap);
        }
        Tone.connect(jl.engine.master.input, analyser);
    };
    attach();

    const ask = (message) =>
        new Promise((resolve) => {
            const id = nextId++;
            pending.set(id, resolve);
            tap.port.postMessage({ ...message, id });
        });

    const analyse = (data) => {
        let peak = 0;
        let sum = 0;
        const crossings = [];
        for (let i = 0; i < data.length; i++) {
            peak = Math.max(peak, Math.abs(data[i]));
            sum += data[i] * data[i];
            if (i && data[i - 1] < 0 && data[i] >= 0) {
                crossings.push(i - data[i] / (data[i] - data[i - 1]));
            }
        }
        const hz = crossings.length > 2 ? (rate * (crossings.length - 1)) / (crossings[crossings.length - 1] - crossings[0]) : 0;
        return { peak, rms: Math.sqrt(sum / data.length), hz };
    };

    /** Records `seconds` from the master bus input (worklet), or reads the analyser's last window. */
    const capture = async (seconds = 0.1) => {
        attach();
        if (tap) {
            const { data, start } = await ask({ type: 'capture', frames: Math.round(seconds * rate) });
            return { ...analyse(data), start };
        }
        // The audio clock moves in bursts (the fake device renders 1024 frames at a time): wait until the whole window
        // was rendered after this call, so it holds nothing from before.
        const from = raw.currentTime;
        while (raw.currentTime - from < Math.max(seconds, analyser.fftSize / rate) + 0.03) {
            await sleep(5);
        }
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        return analyse(data);
    };

    /**
     * Sends `bytes` and measures when the first non-silent sample reaches the master bus: in frames after the frame
     * the context was at when the message arrived, and in wall-clock ms until the tap reported it.
     */
    const onset = async (bytes, threshold = 1e-5) => {
        attach();
        if (!tap) {
            // Analyser fallback: poll every millisecond.
            const buffer = new Float32Array(256);
            const sentAt = window.__fakeMidi.send(bytes);
            for (;;) {
                analyser.getFloatTimeDomainData(buffer);
                if (buffer.some((sample) => Math.abs(sample) > threshold)) {
                    return { polledMs: performance.now() - sentAt };
                }
                if (performance.now() - sentAt > 1000) {
                    return { polledMs: null };
                }
                await sleep(1);
            }
        }
        const found = ask({ type: 'detect', threshold });
        await ask({ type: 'ping' }); // the detector is armed once the worklet answers
        const frameAtEvent = Math.round(raw.currentTime * rate);
        const sentAt = window.__fakeMidi.send(bytes);
        const { frame, receivedAt } = await found;
        return {
            frames: frame - frameAtEvent,
            ms: ((frame - frameAtEvent) / rate) * 1000,
            // Wall clock from the message to the tap reporting the rendered sound (includes the report's own hop back).
            renderedMs: receivedAt - sentAt,
        };
    };

    /** A WAV of sine segments, one per frequency, each `seconds` long. */
    const sineWav = (frequencies, seconds) => {
        const perSlice = Math.round(seconds * rate);
        const frames = perSlice * frequencies.length;
        const buffer = new ArrayBuffer(44 + frames * 2);
        const view = new DataView(buffer);
        const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
        text(0, 'RIFF');
        view.setUint32(4, 36 + frames * 2, true);
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
        view.setUint32(40, frames * 2, true);
        for (let i = 0; i < frames; i++) {
            const hz = frequencies[Math.floor(i / perSlice)];
            view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * (i % perSlice)) / rate) * 0.5 * 32767), true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
    };

    /*
     * How many frames the device renders per callback: headless Chromium's fake device renders 1024 at a time, so an
     * event that just missed a callback waits for the next one, whatever the engine does.
     */
    let burst = 128;
    {
        let last = raw.currentTime;
        const until = performance.now() + 200;
        while (performance.now() < until) {
            if (raw.currentTime !== last) {
                burst = Math.max(burst, Math.round((raw.currentTime - last) * rate));
                last = raw.currentTime;
            }
            await sleep(1);
        }
    }

    window.__jlt = { burst, Tone, jl, workspace: useWorkspace(), history: useHistory(), midi: useMidi(), context, raw, rate, sleep, capture, onset, sineWav, hasWorklet };
}

/* ---- the checks ---- */

/** Adds a synth track to the current container, waits for its engine, and returns its id and engine name. */
const addSynth = (page, { hideWasm = false } = {}) =>
    page.evaluate(async (hide) => {
        const { jl } = window.__jlt;
        const saved = globalThis.WebAssembly;
        if (hide) {
            // `createSynthEngine` then finds no WebAssembly and builds the Tone engine: the fallback, on a page that has a worklet.
            globalThis.WebAssembly = undefined;
        }
        let track;
        try {
            track = jl.addTrack('synth');
        } finally {
            globalThis.WebAssembly = saved;
        }
        const live = jl.tracks.value[jl.tracks.value.length - 1];
        live.setEnvelope('attack', 0.001);
        live.setEnvelope('sustain', 1);
        live.setEnvelope('release', 0.03);
        await live.whenReady();
        return { id: track.id, engine: live.engine?.constructor.name ?? 'none' };
    }, hideWasm);

const setArmed = (page, ids) =>
    page.evaluate((armed) => {
        for (const container of window.__jlt.jl.containers.value) {
            for (const track of container.tracks) {
                track.setArmed(armed.includes(track.id));
            }
        }
    }, ids);

const capture = (page, seconds) => page.evaluate((s) => window.__jlt.capture(s), seconds);
const onset = (page, bytes) => page.evaluate((b) => window.__jlt.onset(b), bytes);
const wait = (page, ms) => page.waitForTimeout(ms);
/** Hz of a MIDI key as the app plays it: standard pitch (`midiNoteName`), 60 is middle C (261.6 Hz), 69 is A4 (440 Hz). */
const hzOf = (midi) => 440 * 2 ** ((midi - 69) / 12);
const near = (hz, target, cents = 15) => hz > 0 && Math.abs(1200 * Math.log2(hz / target)) < cents;

/** Note-on/off, sustain, bend and last-note priority on the track MIDI plays now. `label` names the engine. */
const synthChecks = async (page, label, { precise }) => {
    if (!precise) {
        // Without a worklet tap the onset is polled from an analyser: a coarse wall-clock figure, median of five.
        const polled = [];
        for (let i = 0; i < 5; i++) {
            polled.push((await onset(page, noteOn(69))).polledMs ?? Infinity);
            await sendMidi(page, noteOff(69));
            await wait(page, 200);
        }
        polled.sort((a, b) => a - b);
        check(polled[2] < 100, `${label}: note-on sounds`, `seen by polling after ${polled.map((ms) => ms.toFixed(0)).join(', ')} ms`);
    }
    const on = await onset(page, noteOn(69));
    if (precise) {
        const burst = await page.evaluate(() => window.__jlt.burst);
        check(
            on.frames <= burst + 128,
            `${label}: note-on sounds in the next render callback`,
            `${on.frames} frames = ${on.ms.toFixed(2)} ms after the event (the device renders ${burst} frames per callback)`,
        );
    }
    let heard = await capture(page, 0.1);
    check(heard.rms > 0.1 && near(heard.hz, hzOf(69)), `${label}: key 69 (A4) held`, `rms ${heard.rms.toFixed(3)}, ${heard.hz.toFixed(1)} Hz`);
    await wait(page, 400);
    heard = await capture(page, 0.1);
    check(heard.rms > 0.1, `${label}: still sounding while held (0.5 s)`, `rms ${heard.rms.toFixed(3)}`);

    // Pitch bend: +1 is +2 semitones (the default range); the centre brings it back.
    await sendMidi(page, pitchBend(1));
    await wait(page, 60);
    heard = await capture(page, 0.1);
    check(near(heard.hz, hzOf(71)), `${label}: full bend up is +2 semitones`, `${heard.hz.toFixed(1)} Hz (want ${hzOf(71).toFixed(1)})`);
    await sendMidi(page, pitchBend(-0.5));
    await wait(page, 60);
    heard = await capture(page, 0.1);
    check(near(heard.hz, hzOf(68)), `${label}: half bend down is -1 semitone`, `${heard.hz.toFixed(1)} Hz (want ${hzOf(68).toFixed(1)})`);
    await sendMidi(page, pitchBend(0));
    await wait(page, 60);

    await sendMidi(page, noteOff(69));
    await wait(page, 250);
    heard = await capture(page, 0.1);
    check(heard.peak < 1e-3, `${label}: note-off releases`, `peak ${heard.peak.toExponential(1)} 250 ms after`);

    // Sustain pedal: the note-off waits for the pedal.
    await sendMidi(page, sustain(true));
    await sendMidi(page, noteOn(72));
    await wait(page, 50);
    await sendMidi(page, noteOff(72));
    await wait(page, 300);
    heard = await capture(page, 0.1);
    check(heard.rms > 0.1 && near(heard.hz, hzOf(72)), `${label}: sustain holds a released key`, `rms ${heard.rms.toFixed(3)}, ${heard.hz.toFixed(1)} Hz`);
    await sendMidi(page, sustain(false));
    await wait(page, 250);
    heard = await capture(page, 0.1);
    check(heard.peak < 1e-3, `${label}: pedal up releases it`, `peak ${heard.peak.toExponential(1)}`);

    // Cut mode (the synth default): the newest key wins; when it comes up, the one still held takes over.
    await sendMidi(page, noteOn(60));
    await wait(page, 50);
    await sendMidi(page, noteOn(64));
    await wait(page, 60);
    heard = await capture(page, 0.1);
    check(near(heard.hz, hzOf(64)), `${label}: last note wins`, `${heard.hz.toFixed(1)} Hz (want ${hzOf(64).toFixed(1)})`);
    await sendMidi(page, noteOff(64));
    await wait(page, 60);
    heard = await capture(page, 0.1);
    check(heard.rms > 0.1 && near(heard.hz, hzOf(60)), `${label}: releasing it falls back to the held key`, `${heard.hz.toFixed(1)} Hz, rms ${heard.rms.toFixed(3)}`);
    await sendMidi(page, noteOff(60));
    await wait(page, 250);
    heard = await capture(page, 0.1);
    check(heard.peak < 1e-3, `${label}: silent after the last key`, `peak ${heard.peak.toExponential(1)}`);
};

/** Sampler: keys pick slices (C5, key 72, the first), gate stops the voice at the note-off, one-shot plays the slice out. */
const samplerChecks = async (page, label) => {
    const id = await page.evaluate(async () => {
        const { jl, sineWav } = window.__jlt;
        const track = jl.addTrack('sampler');
        const live = jl.tracks.value[jl.tracks.value.length - 1];
        await live.loadSample(sineWav([220, 330, 440, 660], 0.5), 'slices.wav');
        live.sliceEvenly(4);
        await live.whenReady();
        return track.id;
    });
    await setArmed(page, [id]);
    const frequencies = [220, 330, 440, 660];
    for (let slice = 0; slice < 4; slice++) {
        await sendMidi(page, noteOn(72 + slice));
        await wait(page, 60);
        const heard = await capture(page, 0.1);
        check(near(heard.hz, frequencies[slice], 20), `${label}: key ${72 + slice} plays slice ${slice + 1}`, `${heard.hz.toFixed(1)} Hz (want ${frequencies[slice]})`);
        await sendMidi(page, noteOff(72 + slice));
        await wait(page, 500);
    }
    // One-shot (default): the slice plays on after the note-off.
    await sendMidi(page, noteOn(72));
    await wait(page, 40);
    await sendMidi(page, noteOff(72));
    await wait(page, 100);
    let heard = await capture(page, 0.1);
    const spans = await page.evaluate(
        (trackId) => JSON.stringify([...window.__jlt.jl.tracks.value.find((track) => track.id === trackId).voices.values()].map((span) => [span.start.toFixed(3), span.end.toFixed(3)])) + ` now ${window.__jlt.raw.currentTime.toFixed(3)}`,
        id,
    );
    check(heard.rms > 0.05, `${label}: one-shot ignores the note-off`, `rms ${heard.rms.toFixed(3)} after the note-off; voices ${spans}`);
    await wait(page, 500);
    await page.evaluate((trackId) => window.__jlt.jl.tracks.value.find((track) => track.id === trackId).setGate(true), id);
    await sendMidi(page, noteOn(73));
    await wait(page, 40);
    await sendMidi(page, noteOff(73));
    await wait(page, 60);
    heard = await capture(page, 0.1);
    check(heard.peak < 1e-3, `${label}: gate stops the voice at the note-off`, `peak ${heard.peak.toExponential(1)}`);
    await page.evaluate((trackId) => window.__jlt.jl.removeTrack(trackId), id);
};

const rustPass = async () => {
    const browser = await launch(true);
    try {
        const page = await openStudio(browser);
        const hasWorklet = await page.evaluate(() => window.__jlt.hasWorklet);
        check(hasWorklet, 'rust: AudioWorklet available (secure-origin flag)');

        // The UI: the MIDI chip, the popover, "Enable MIDI", the device list.
        await page.locator('.midichip').click();
        await page.getByRole('button', { name: 'Enable MIDI' }).click();
        await page.getByText('Fake Keyboard').waitFor({ timeout: 5000 });
        check(true, 'rust: Enable MIDI lists the fake keyboard');
        await page.keyboard.press('Escape');
        const midiState = await page.evaluate(() => window.__jlt.midi.state.value);
        check(midiState === 'on', 'rust: MIDI state is on', midiState);

        // Remembered grant: a reload turns MIDI on by itself after the first click.
        const synth = await addSynth(page);
        check(synth.engine === 'SynthVoices', 'rust: synth runs the Rust engine', synth.engine);
        // Nothing armed: the selected (first) track plays.
        await synthChecks(page, 'rust', { precise: true });

        // MIDI learn through the UI: Learn, open the track's Sound page, click Attack, move CC 74.
        await page.evaluate((id) => window.__jlt.workspace.openTrack(id, 'sound'), synth.id);
        await page.locator('.midibar .chip', { hasText: 'Learn' }).click();
        const attack = page.locator('.dock--left [role="slider"][aria-label="Attack"]');
        await attack.waitFor();
        const learnable = await page.locator('.dock--left .knob--learnable').count();
        check(learnable >= 5, 'rust: learn mode highlights the knobs', `${learnable} learnable knobs in the track panel`);
        await attack.click();
        await sendMidi(page, controlChange(74, 64));
        const mappings = await page.evaluate(() => JSON.parse(JSON.stringify(window.__jlt.jl.engine.sequencer.midiMappings)));
        check(mappings.length === 1 && mappings[0].cc === 74 && mappings[0].param === 'envelope.attack', 'rust: learn maps CC 74 to Attack', JSON.stringify(mappings[0]));
        await page.keyboard.press('Escape');
        const before = await page.evaluate(() => window.__jlt.history.revision.value);
        for (let value = 0; value <= 127; value += 8) {
            await sendMidi(page, controlChange(74, value));
        }
        await sendMidi(page, controlChange(74, 127));
        const knob = await attack.getAttribute('aria-valuenow');
        const stored = await page.evaluate((id) => window.__jlt.jl.tracks.value.find((track) => track.id === id).envelope.attack, synth.id);
        check(stored === 2 && Number(knob) === 2, 'rust: CC 127 turns Attack to its maximum, knob follows', `stored ${stored}, knob ${knob}`);
        await wait(page, 700);
        const after = await page.evaluate(() => window.__jlt.history.revision.value);
        check(after - before === 1, 'rust: a controller gesture is one undo step', `${after - before} history entries`);
        await page.evaluate(() => window.__jlt.history.undo());
        const undone = await page.evaluate((id) => window.__jlt.jl.tracks.value.find((track) => track.id === id).envelope.attack, synth.id);
        check(undone === 0.001, 'rust: undo takes the gesture back', `attack ${undone}`);
        // The mapping is in the session: it survives in history captures.
        const captured = await page.evaluate(() => window.__jlt.jl.engine.capture().midiMappings.length);
        check(captured === 1, 'rust: mappings are part of the session state', captured);

        // Still plays after the undo (history restores the tracks in place).
        await sendMidi(page, noteOn(69));
        await wait(page, 50);
        const afterUndo = await capture(page, 0.1);
        check(afterUndo.rms > 0.1, 'rust: plays after an undo', `rms ${afterUndo.rms.toFixed(3)}`);
        await sendMidi(page, noteOff(69));
        await wait(page, 200);

        await samplerChecks(page, 'rust sampler');

        // Hot-plugging: a new input shows up and plays; unplugging it stops its held note; a switched-off input is ignored.
        await page.evaluate(() => window.__fakeMidi.plug('kbd-2', 'Second Keys'));
        const listed = await page.evaluate(() => window.__jlt.midi.devices.value.map((device) => `${device.name}:${device.connected}:${device.enabled}`));
        check(listed.includes('Second Keys:true:true'), 'rust: a plugged-in input is listed and on', listed.join(', '));
        await sendMidi(page, noteOn(69), 'kbd-2');
        await wait(page, 60);
        let plugged = await capture(page, 0.1);
        check(plugged.rms > 0.1, 'rust: the new input plays', `rms ${plugged.rms.toFixed(3)}`);
        await page.evaluate(() => window.__fakeMidi.unplug('kbd-2'));
        await wait(page, 250);
        plugged = await capture(page, 0.1);
        check(plugged.peak < 1e-3, 'rust: unplugging it stops its held note', `peak ${plugged.peak.toExponential(1)}`);
        await page.evaluate(() => window.__jlt.midi.setDeviceEnabled('fake-kbd', false));
        await sendMidi(page, noteOn(69));
        await wait(page, 60);
        plugged = await capture(page, 0.1);
        check(plugged.peak < 1e-3, 'rust: a switched-off input is not heard', `peak ${plugged.peak.toExponential(1)}`);
        const remembered = await page.evaluate(() => localStorage.getItem('juicyloops:midiDisabled'));
        await page.evaluate(() => window.__jlt.midi.setDeviceEnabled('fake-kbd', true));
        await sendMidi(page, noteOff(69));
        check(remembered?.includes('fake-kbd'), 'rust: switched-off inputs are remembered', remembered);

        // An armed track in a sleeping container: the note wakes it.
        const sleeping = await page.evaluate(async () => {
            const { jl, sleep } = window.__jlt;
            const first = jl.currentContainer.value.id;
            const container = jl.addContainer();
            const track = jl.addTrack('synth');
            const live = jl.tracks.value[0];
            live.setEnvelope('sustain', 1);
            live.setEnvelope('release', 0.03);
            jl.selectContainer(first);
            jl.play();
            // Loop mode plays the first container; the other sleeps once its tail rang out.
            await sleep(3500);
            const raw = jl.engine.containers.find((candidate) => candidate.id === container.id);
            return { id: track.id, containerId: container.id, asleep: !raw.isAwake };
        });
        check(sleeping.asleep, 'rust: the other container went to sleep while the loop played');
        await setArmed(page, [sleeping.id]);
        const wake = await onset(page, noteOn(69));
        const awake = await page.evaluate((id) => window.__jlt.jl.engine.containers.find((c) => c.id === id).isAwake, sleeping.containerId);
        check(awake && wake.frames <= 1024, 'rust: a note on an armed track in a sleeping container wakes it and sounds', `${wake.frames} frames after the event`);
        await wait(page, 2500);
        const held = await capture(page, 0.1);
        check(held.rms > 0.1, 'rust: it stays awake while the key is held (2.5 s, loop playing)', `rms ${held.rms.toFixed(3)}`);
        await sendMidi(page, noteOff(69));
        await page.evaluate(() => window.__jlt.jl.stop());
        await wait(page, 300);
        await setArmed(page, []);
        await page.evaluate(() => window.__jlt.jl.selectContainer(window.__jlt.jl.containers.value[0].id));

        // The Tone engine on the same secure page, measured with the same tap.
        const tone = await addSynth(page, { hideWasm: true });
        check(tone.engine === 'ToneSynthEngine', 'rust page: Tone engine built for comparison', tone.engine);
        await setArmed(page, [tone.id]);
        await synthChecks(page, 'tone (secure page)', { precise: true });
        await setArmed(page, []);

        // A reload remembers the grant and turns MIDI on by itself.
        await page.reload({ waitUntil: 'load' });
        await page.locator('.modecard[data-mode="pro"]').click({ timeout: 30000 });
        await page.waitForFunction(() => document.querySelector('.midichip')?.getAttribute('data-state') === 'on', null, { timeout: 5000 }).then(
            () => check(true, 'rust: MIDI comes back by itself after a reload'),
            () => check(false, 'rust: MIDI comes back by itself after a reload'),
        );
    } finally {
        await browser.close();
    }
};

const tonePass = async () => {
    const browser = await launch(false);
    try {
        const page = await openStudio(browser);
        const hasWorklet = await page.evaluate(() => window.__jlt.hasWorklet);
        check(!hasWorklet, 'tone: insecure origin has no AudioWorklet');
        await page.evaluate(() => window.__jlt.midi.enable());
        const synth = await addSynth(page);
        check(synth.engine === 'ToneSynthEngine', 'tone: synth falls back to the Tone engine', synth.engine);
        await synthChecks(page, 'tone', { precise: false });
        await samplerChecks(page, 'tone sampler');
    } finally {
        await browser.close();
    }
};

const latencyPass = async () => {
    const rows = [];
    for (const lowLatency of [true, false]) {
        const browser = await launch(true);
        try {
            const page = await openStudio(browser, { lowLatency });
            await page.evaluate(() => window.__jlt.midi.enable());
            const info = await page.evaluate(() => {
                const { raw, midi, rate } = window.__jlt;
                const native = raw._nativeContext ?? raw;
                return { hint: midi.activeLatency, base: native.baseLatency, output: native.outputLatency, rate };
            });
            for (const engine of ['rust', 'tone']) {
                const synth = await addSynth(page, { hideWasm: engine === 'tone' });
                await setArmed(page, [synth.id]);
                const samples = [];
                for (let i = 0; i < 12; i++) {
                    samples.push(await onset(page, noteOn(69)));
                    await wait(page, 30);
                    await sendMidi(page, noteOff(69));
                    await wait(page, 120);
                }
                const median = (key) => {
                    const values = samples.map((sample) => sample[key]).filter((value) => value !== null).sort((a, b) => a - b);
                    return values.length ? values[Math.floor(values.length / 2)] : null;
                };
                const max = (key) => Math.max(...samples.map((sample) => sample[key] ?? -Infinity));
                rows.push({
                    hint: info.hint,
                    engine: synth.engine,
                    'onset after event, ms (median/max)': `${median('ms').toFixed(2)} / ${max('ms').toFixed(2)}`,
                    'rendered, wall ms (median/max)': `${median('renderedMs').toFixed(1)} / ${max('renderedMs').toFixed(1)}`,
                    'baseLatency ms': (info.base * 1000).toFixed(1),
                    'outputLatency ms': (info.output * 1000).toFixed(1),
                });
                const burst = await page.evaluate(() => window.__jlt.burst);
                check(max('frames') <= burst + 128, `latency ${info.hint} ${synth.engine}: every onset in the next render callback`, `max ${max('frames')} frames, callbacks of ${burst}`);
                await setArmed(page, []);
            }
        } finally {
            await browser.close();
        }
    }
    console.log(
        '\nLive latency. Onset: first non-silent sample at the master bus, in context time after the frame the context was at when the message arrived.' +
            ' Rendered: wall clock until the tap reported it. The device adds baseLatency + outputLatency on top.' +
            ' (getOutputTimestamp is left out: the fake audio device of headless Chromium reports stale stamps.)',
    );
    console.table(rows);
};

const main = async () => {
    if (!only || only === "rust") {
        await rustPass();
    }
    if (!only || only === 'tone') {
        await tonePass();
    }
    if (!only || only === 'latency') {
        await latencyPass();
    }
    const failed = results.filter((result) => result.pass !== 'ok').length;
    console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
