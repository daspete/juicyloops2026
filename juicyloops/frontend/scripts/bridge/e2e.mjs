#!/usr/bin/env node
/**
 * End-to-end check of desktop plugins (the Juicy Loops Bridge) in the studio, in Chromium.
 *
 *   node scripts/bridge/e2e.mjs [studio URL]        (default http://127.0.0.1:5199/app)
 *
 * Needs: a running dev server for the studio (any port; the page must be on 127.0.0.1 or localhost, which are secure
 * origins, so AudioWorklet works), the bridge built (`bash vst-bridge/scripts/build.sh` or a `cargo build
 * --release`), and its test plugins (`bash vst-bridge/scripts/fixtures.sh`). The script starts its own bridge on
 * port 47893 with a throw-away settings folder and the built-in test plugins, so it does not touch a real one.
 *
 * Checks: pairing and the plugin list in the browser dialog; live instruments (bridge test synth, Clack's CLAP
 * polysynth, a VST3 test synth) sound on the frame their note was scheduled; a live effect comes out exactly
 * `LIVE_EFFECT_DELAY_FRAMES` late at its gain; the studio's own export renders a bridge synth from frame 0 and a
 * bridge effect one export block late; plugins come back by themselves after the bridge restarts. Prints the
 * measured numbers; exits 1 when a check fails.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const { chromium } = await import(join(root, 'node_modules/playwright/index.mjs'));

const STUDIO = process.argv[2] ?? 'http://127.0.0.1:5199/app';
const PORT = 47893;
const TOKEN = 'e2et-oken0-0000-0000-0000';
const BRIDGE = process.env.JL_BRIDGE_BIN ?? join(root, 'vst-bridge/target/release/juicyloops-bridge');
const FIXTURES = join(root, 'vst-bridge/fixtures/build');

const home = mkdtempSync(join(tmpdir(), 'jl-bridge-e2e-'));
writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ port: PORT, token: TOKEN, allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'], extraPluginPaths: [] }),
);

const startBridge = (scan) =>
    spawn(
        BRIDGE,
        ['--headless', '--builtin-plugins', ...(scan ? [] : ['--no-scan']), '--plugin-path', join(FIXTURES, 'clap'), '--plugin-path', join(FIXTURES, 'vst3')],
        {
            env: { ...process.env, JUICYLOOPS_BRIDGE_HOME: home, JUICYLOOPS_BRIDGE_LOG: 'warn' },
            stdio: 'ignore',
        },
    );

const failures = [];
const check = (name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    if (!ok) {
        failures.push(name);
    }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let bridge = startBridge(true);
await sleep(1500);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.addInitScript((port) => {
        sessionStorage.setItem('juicyloops:splash', 'skip');
        localStorage.setItem('juicyloops:tour', 'done');
        localStorage.setItem('juicyloops:bridge:port', String(port));
    }, PORT);
    await page.goto(STUDIO);
    await page.click('.modecard[data-mode="pro"]');
    await page.waitForTimeout(1500);

    /* ---- pairing and the list ---- */
    const openBrowser = (kind) =>
        page.evaluate(async (kind) => {
            const url = performance
                .getEntriesByType('resource')
                .map((entry) => entry.name)
                .find((name) => name.includes('/src/composables/usePlugins.ts'));
            const { usePlugins } = await import(url ?? '/src/composables/usePlugins.ts');
            usePlugins().openBrowser(kind, (plugin) => (window.__picked = plugin));
        }, kind);
    await openBrowser('instrument');
    await page.waitForSelector('.bridge-section');
    await page.fill('#bridge-token', TOKEN);
    await page.click('.bridge-pair button[type=submit]');
    await page.waitForSelector('.bridge-grid .plugin-pick', { timeout: 15000 });
    const instruments = await page.locator('.bridge-grid .plugin-name').allTextContents();
    check('pairs and lists desktop instruments', instruments.includes('Clack PolySynth Example') && instruments.includes('VST3 Host Test Synth'), instruments);
    await page.locator('.bridge-grid .plugin-pick', { hasText: 'Bridge Test Synth' }).click();
    const picked = await page.evaluate(() => window.__picked);
    check('picking gives a vstbridge: plugin', picked?.url === 'vstbridge:builtin:sine-synth', picked);

    /* ---- live ---- */
    const live = await page.evaluate(async () => {
        const resources = () => performance.getEntriesByType('resource').map((entry) => entry.name);
        const load = (path) => import(resources().find((name) => name.includes(path) && !name.includes('?worker')) ?? path);
        const Tone = await import(resources().find((name) => name.includes('/deps/tone.js')));
        await Tone.start();
        const { nativeContextOf, nativeNodeOf } = await load('/src/juicyloops/plugins/wamHost.ts');
        const { WamInstrument } = await load('/src/juicyloops/plugins/WamInstrument.ts');
        const { WamEffect } = await load('/src/juicyloops/plugins/WamEffect.ts');
        const native = nativeContextOf(Tone.getContext());
        const recorder = `class R extends AudioWorkletProcessor { constructor(){ super(); this.first = -1; this.peak = 0; this.port.onmessage = () => this.port.postMessage({ first: this.first, peak: this.peak }); }
            process(inputs){ const samples = inputs[0] && inputs[0][0]; if (samples) for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > this.peak) this.peak = v; if (this.first < 0 && v > 1e-3) this.first = currentFrame + i; } return true; } }
            registerProcessor('bridge-e2e-recorder', R);`;
        await native.audioWorklet.addModule(URL.createObjectURL(new Blob([recorder], { type: 'text/javascript' })));
        const record = (node) => {
            const tap = new AudioWorkletNode(native, 'bridge-e2e-recorder');
            tap.connect(native.destination);
            node.connect(tap);
            return () =>
                new Promise((done) => {
                    tap.port.onmessage = (event) => done(event.data);
                    tap.port.postMessage('read');
                });
        };
        const wait = (ms) => new Promise((done) => setTimeout(done, ms));
        const sr = native.sampleRate;
        const out = { sampleRate: sr, instruments: {} };
        for (const [label, url] of [
            ['Bridge Test Synth', 'vstbridge:builtin:sine-synth'],
            ['CLAP polysynth', 'vstbridge:clap:org.rust-audio.clack.polysynth'],
            ['VST3 TestSynth', 'vstbridge:vst3:5445535453594E5450524F4300000001'],
        ]) {
            const instrument = new WamInstrument({
                context: Tone.getContext(),
                owner: `e2e ${label}`,
                plugin: { url, name: label, state: null },
                bendRange: 2,
            });
            await instrument.whenReady();
            const read = record(nativeNodeOf(instrument.output));
            await wait(300);
            const time = Tone.now() + 0.2;
            instrument.triggerAttackRelease('A4', 0.4, time, 0.9);
            await wait(900);
            const heard = await read();
            out.instruments[label] = { offsetFrames: heard.first - Math.round(time * sr), peak: heard.peak, stats: await instrument.module.audioNode.stats() };
            instrument.dispose();
        }
        const effect = new WamEffect({ context: Tone.getContext(), owner: 'e2e effect', plugin: { url: 'vstbridge:builtin:gain', name: 'gain', state: null } });
        await effect.ready;
        const read = record(nativeNodeOf(effect.output));
        await wait(400);
        const step = native.createConstantSource();
        step.offset.value = 0.8;
        step.connect(nativeNodeOf(effect.input));
        const at = native.currentTime + 0.1;
        step.start(at);
        step.stop(at + 0.2);
        await wait(700);
        const heard = await read();
        out.effect = { delayFrames: heard.first - Math.round(at * sr), peak: heard.peak, stats: await effect.module.audioNode.stats() };
        effect.dispose();
        return out;
    });
    for (const [label, result] of Object.entries(live.instruments)) {
        check(`live ${label}: the note sounds on its frame`, Math.abs(result.offsetFrames) <= 8 && result.peak > 0.05, {
            offsetFrames: result.offsetFrames,
            peak: +result.peak.toFixed(3),
            roundTripFrames: result.stats.roundTrip,
            underruns: result.stats.underruns,
        });
        check(`live ${label}: no gaps`, result.stats.underruns === 0, result.stats.underruns);
    }
    check(
        'live effect: exactly its delay late, at its gain',
        live.effect.delayFrames === live.effect.stats.delayFrames && Math.abs(live.effect.peak - 0.4) < 0.01,
        {
            delayFrames: live.effect.delayFrames,
            delayMs: +((live.effect.delayFrames / live.sampleRate) * 1000).toFixed(1),
            peak: +live.effect.peak.toFixed(3),
            roundTripFrames: live.effect.stats.roundTrip,
        },
    );

    /* ---- the studio's export ---- */
    const exported = await page.evaluate(async () => {
        const resources = () => performance.getEntriesByType('resource').map((entry) => entry.name);
        const load = (path) => import(resources().find((name) => name.includes(path) && !name.includes('?worker')) ?? path);
        const jl = (await load('/src/composables/useJuicyLoops.ts')).useJuicyLoops();
        const { renderSession } = await load('/src/juicyloops/render.ts');
        const made = jl.addTrack('synth');
        const track = jl.tracks.value.find((candidate) => candidate.id === made.id);
        track.setPlugin({ url: 'vstbridge:clap:org.rust-audio.clack.polysynth', name: 'Clack PolySynth Example', vendor: '', state: null });
        track.activateEveryNth(4);
        await track.whenReady();
        window.__e2e = { jl, track };
        const render = async () => {
            await jl.engine.refreshPluginStates();
            const started = performance.now();
            const audio = await renderSession(jl.engine.capture(), {
                bpm: jl.bpm.value,
                scope: { kind: 'container', containerId: jl.currentContainer.value.id, repeats: 1 },
                tail: 0.5,
            });
            const ms = performance.now() - started;
            const left = audio.channels[0];
            let first = -1;
            let peak = 0;
            for (let i = 0; i < left.length; i++) {
                const value = Math.abs(left[i]);
                peak = Math.max(peak, value);
                if (first < 0 && value > 1e-3) first = i;
            }
            return { seconds: left.length / audio.sampleRate, ms, first, peak };
        };
        const dry = await render();
        track.effects.addPlugin({ url: 'vstbridge:builtin:gain', name: 'Bridge Test Gain', vendor: 'Juicy Loops', state: null });
        await track.effects.whenReady();
        const wet = await render();
        return { dry, wet, state: JSON.stringify(track.plugin.state ?? null).slice(0, 40) };
    });
    check('export: a bridge synth starts on frame 0', exported.dry.first === 0 && exported.dry.peak > 0.05, {
        ...exported.dry,
        ms: Math.round(exported.dry.ms),
    });
    check(
        'export: a bridge effect plays one export block (512 frames) late at its gain',
        exported.wet.first === 512 && Math.abs(exported.wet.peak - exported.dry.peak / 2) < 0.01,
        { ...exported.wet, ms: Math.round(exported.wet.ms) },
    );
    check('the session stores the plugin state', exported.state.includes('vstbridge'), exported.state);

    /* ---- the bridge restarts ---- */
    bridge.kill('SIGKILL');
    await sleep(1500);
    bridge = startBridge(false);
    await sleep(6000);
    const back = await page.evaluate(async () => {
        const url = performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .find((name) => name.includes('/src/juicyloops/bridge/client.ts'));
        const { bridge } = await import(url);
        const node = window.__e2e.track.pluginEngine.module.audioNode;
        const before = (await node.stats()).played;
        await new Promise((done) => setTimeout(done, 500));
        return { state: bridge.state.value, playing: (await node.stats()).played - before };
    });
    check('plugins come back after the bridge restarts', back.state === 'ready' && back.playing > 50, back);
} catch (error) {
    check('the run', false, String(error?.stack ?? error));
} finally {
    await browser.close();
    bridge.kill();
    rmSync(home, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
