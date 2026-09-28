/**
 * Audio performance run: `yarn perf [label] [--compare <file>] [options]`.
 *
 * For every benchmark fixture (see `fixtures.mjs`) a fresh page opens the studio, builds and opens the session,
 * and then:
 *   1. plays it in loop mode and in song mode for `--seconds` each, polling Chrome's Web Audio realtime data
 *      (CDP `WebAudio.getRealtimeData`) for render capacity and callback timing;
 *   2. sweeps the pitch knob of a sample track the way a drag does, while playing, and records main-thread long
 *      tasks (> 50 ms);
 *   3. reads the live Tone node count from the dev-only counter (`src/juicyloops/debug/nodeCounter.ts`).
 * Every phase also times the sequencer's step callback (`Sequencer.playStep`, wrapped in the page) on the main
 * thread: calls, mean, 95th percentile and max in milliseconds.
 *
 * The result goes to `scripts/perf/results/<label>.json` (label defaults to the git short sha) and a table is
 * printed, next to a previous result when `--compare` names one.
 *
 * Needs the dev server (the node counter only exists in DEV builds). Options:
 *   --url <url>          studio URL (default http://juicyloops.test/app, resolved to 127.0.0.1)
 *   --fixtures a,b       which fixtures (default: all)
 *   --seconds <n>        seconds per playback mode (default 20)
 *   --headed             show the browser
 *   --save-fixtures      also write the fixtures as `.juicyloops` files into `scripts/perf/fixtures/`
 *   --latency <hint>     `interactive` or `balanced`: sets the app's "low latency" setting (`juicyloops:lowLatency`)
 *                        before the page loads; without it the app's default applies (interactive since the MIDI work,
 *                        balanced before, and in every result up to `tier2-2`/`phase1`)
 */
import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture, FIXTURES } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

/* ---- arguments ---- */

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);
const VALUE_OPTIONS = new Set(['--url', '--fixtures', '--seconds', '--compare', '--latency']);
const positional = args.filter((arg, index) => !arg.startsWith('--') && !VALUE_OPTIONS.has(args[index - 1]));

const git = (command) => {
    try {
        return execSync(`git ${command}`, { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
        return null;
    }
};

const commit = git('rev-parse --short HEAD') ?? 'unknown';
const label = positional[0] ?? commit;
const url = option('url', 'http://juicyloops.test/app');
const seconds = Number(option('seconds', 20));
const fixtureNames = option('fixtures', Object.keys(FIXTURES).join(',')).split(',');
const comparePath = option('compare');
const latency = option('latency');
if (latency !== null && latency !== 'interactive' && latency !== 'balanced') {
    throw new Error(`--latency must be 'interactive' or 'balanced', not '${latency}'`);
}

/** How often the Web Audio realtime data is read. */
const POLL_MS = 250;
/** Playback runs this long before measuring starts, so start-up work does not count. */
const WARMUP_MS = 2000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ---- statistics ---- */

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const max = (values) => (values.length ? Math.max(...values) : null);

/** The realtime samples of one playback phase, reduced to what the table shows. */
const summarize = ({ samples, callbackMs }) => ({
    samples: samples.length,
    /* What one callback may take in real time: the device buffer's length. */
    nominalCallbackMs: callbackMs,
    renderCapacityMean: mean(samples.map((sample) => sample.renderCapacity)),
    renderCapacityMax: max(samples.map((sample) => sample.renderCapacity)),
    /* Chrome reports the callback interval in seconds; milliseconds read better. */
    callbackIntervalMeanMs: mean(samples.map((sample) => sample.callbackIntervalMean * 1000)),
    callbackIntervalVarianceMean: mean(samples.map((sample) => sample.callbackIntervalVariance)),
    callbackIntervalVarianceMax: max(samples.map((sample) => sample.callbackIntervalVariance)),
    /*
     * Render capacity tops out at 1: past that the device just calls back late. Stretching it by how late the
     * callbacks come gives a load that keeps growing (1 = exactly real time, 3 = three times too slow), so
     * changes stay visible on a session the machine cannot play in time.
     */
    load: callbackMs ? mean(samples.map((sample) => sample.renderCapacity * Math.max(1, (sample.callbackIntervalMean * 1000) / callbackMs))) : null,
});

/** Step callback durations (ms) of one phase. */
const summarizeSteps = (durations) => {
    const sorted = [...durations].sort((a, b) => a - b);
    return {
        count: sorted.length,
        meanMs: mean(sorted),
        p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
        maxMs: max(sorted),
    };
};

const summarizeLongTasks = (tasks) => ({
    count: tasks.length,
    maxMs: max(tasks.map((task) => task.duration)) ?? 0,
    totalMs: tasks.reduce((sum, task) => sum + task.duration, 0),
});

/* ---- in-page helpers (run through page.evaluate, so they must be self-contained) ---- */

/** Clicks through the welcome overlay (the user gesture that unlocks audio) and waits until the engine runs. */
const openStudio = async (page) => {
    /* Not 'networkidle': the sample worker's module request (a blob: URL in dev) never counts as finished. */
    await page.goto(url, { waitUntil: 'load' });
    await page.locator('.modecard[data-mode="pro"]').click({ timeout: 30000 });
    await page.waitForFunction(() => typeof globalThis.__jlNodeCount === 'number', null, { timeout: 10000 }).catch(() => {
        throw new Error('No node counter on the page: is this the dev server (the counter only exists in DEV builds)?');
    });
    /* Long tasks are collected from here on; each phase reads the ones inside its own window. */
    await page.evaluate(() => {
        globalThis.__perfLongTasks = [];
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                globalThis.__perfLongTasks.push({ start: entry.startTime, duration: entry.duration });
            }
        }).observe({ type: 'longtask', buffered: true });
    });
    /* Times every step callback: the transport's repeat calls `this.playStep(time)`, so an own property wins. */
    return page.evaluate(async () => {
        const load = (path) => {
            const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path);
            return import(loaded ? loaded.name : path);
        };
        const module = await load('/src/juicyloops/engine.ts');
        const sequencer = module.engine.sequencer;
        const playStep = Object.getPrototypeOf(sequencer).playStep;
        globalThis.__perfSteps = [];
        sequencer.playStep = function (time) {
            const start = performance.now();
            try {
                return playStep.call(this, time);
            } finally {
                globalThis.__perfSteps.push([start, performance.now() - start]);
            }
        };
        const raw = module.engine.transport.context.rawContext;
        const native = raw._nativeAudioContext ?? raw;
        return { latencyHint: module.ENGINE_LATENCY_HINT ?? null, baseLatencyMs: (native.baseLatency ?? 0) * 1000, outputLatencyMs: (native.outputLatency ?? 0) * 1000 };
    });
};

/** Starts playback in a mode. Loop mode plays the first container, song mode starts at the top of the song. */
const startPlayback = (page, mode) =>
    page.evaluate(async (mode) => {
        const load = (path) => {
            const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path);
            return import(loaded ? loaded.name : path);
        };
        const { useJuicyLoops } = await load('/src/composables/useJuicyLoops.ts');
        const jl = useJuicyLoops();
        jl.stop();
        jl.setMode(mode);
        if (mode === 'loop') {
            jl.selectContainer(jl.containers.value[0].id);
        } else {
            jl.cueSong(0);
        }
        jl.play();
        return performance.now();
    }, mode);

const stopPlayback = (page) =>
    page.evaluate(async () => {
        const load = (path) => {
            const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path);
            return import(loaded ? loaded.name : path);
        };
        const { useJuicyLoops } = await load('/src/composables/useJuicyLoops.ts');
        useJuicyLoops().stop();
        return performance.now();
    });

/**
 * Drags the pitch knob of the first sample track of the current container: runs of one-semitone steps 30 ms apart,
 * with rests long enough (400 ms) for the debounced re-render (`timeStretch`) to run after each one.
 */
const sweepPitch = (page) =>
    page.evaluate(async () => {
        const load = (path) => {
            const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path);
            return import(loaded ? loaded.name : path);
        };
        const { useJuicyLoops } = await load('/src/composables/useJuicyLoops.ts');
        const track = useJuicyLoops().tracks.value.find((candidate) => typeof candidate.setPitch === 'function');
        if (!track) {
            throw new Error('The fixture has no sample track in its first container.');
        }
        const wait = (ms) => new Promise((done) => setTimeout(done, ms));
        const from = performance.now();
        const targets = [7, -5, 12, -12, 3, 0];
        let renders = 0;
        for (const target of targets) {
            while (track.pitch !== target) {
                track.setPitch(track.pitch + Math.sign(target - track.pitch));
                await wait(30);
            }
            renders++;
            await wait(400);
        }
        await track.whenReady();
        return { from, to: performance.now(), renders };
    });

const readLongTasks = (page, from, to) =>
    page.evaluate(({ from, to }) => globalThis.__perfLongTasks.filter((task) => task.start >= from && task.start <= to), { from, to });

const readSteps = (page, from, to) =>
    page.evaluate(({ from, to }) => globalThis.__perfSteps.filter(([start]) => start >= from && start <= to).map(([, duration]) => duration), { from, to });

const readNodes = (page) => page.evaluate(() => ({ count: globalThis.__jlNodeCount, byType: globalThis.__jlNodeCounts() }));

/* ---- Web Audio realtime data over CDP ---- */

/**
 * Finds the engine's audio context and polls its realtime data.
 *
 * The page has several realtime contexts: Tone makes a default one when it is imported (the engine then installs
 * its own and closes Tone's), and other code probes the browser with small ones. The engine's context is the one with by far the most
 * audio nodes, so contexts are told apart by counting CDP's node events.
 */
const watchAudio = async (cdp) => {
    const nodes = new Map();
    const callbackMs = new Map();
    cdp.on('WebAudio.contextCreated', ({ context }) => {
        if (context.contextType === 'realtime') {
            nodes.set(context.contextId, 0);
            callbackMs.set(context.contextId, (context.callbackBufferSize / context.sampleRate) * 1000);
        }
    });
    cdp.on('WebAudio.contextWillBeDestroyed', ({ contextId }) => nodes.delete(contextId));
    cdp.on('WebAudio.audioNodeCreated', ({ node }) => nodes.has(node.contextId) && nodes.set(node.contextId, nodes.get(node.contextId) + 1));
    await cdp.send('WebAudio.enable');

    const engineContext = () => [...nodes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    /** Polls the engine's context for `ms` (or until `isDone` says so) and returns the samples. */
    const poll = async (ms, isDone = () => false) => {
        const contextId = engineContext();
        const samples = [];
        const until = Date.now() + ms;
        while (contextId && Date.now() < until && !isDone()) {
            try {
                const { realtimeData } = await cdp.send('WebAudio.getRealtimeData', { contextId });
                samples.push(realtimeData);
            } catch {
                /* Not rendering (yet); the phase simply gets fewer samples. */
            }
            await sleep(POLL_MS);
        }
        return { samples, callbackMs: callbackMs.get(contextId) ?? null };
    };
    return { poll };
};

/* ---- one fixture ---- */

const runFixture = async (browser, name) => {
    const spec = FIXTURES[name];
    if (!spec) {
        throw new Error(`Unknown fixture "${name}". Known: ${Object.keys(FIXTURES).join(', ')}`);
    }
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    if (latency) {
        await context.addInitScript((low) => localStorage.setItem('juicyloops:lowLatency', low), String(latency === 'interactive'));
    }
    const page = await context.newPage();
    page.on('pageerror', (error) => console.warn(`  [${name}] page error: ${error.message}`));
    const cdp = await context.newCDPSession(page);
    const audio = await watchAudio(cdp);

    console.log(`- ${name}: opening the studio`);
    const audioContext = await openStudio(page);
    /* A reload (the dev server reacting to a file change) would silently throw the session away. */
    let reloads = 0;
    page.on('framenavigated', (frame) => frame === page.mainFrame() && reloads++);
    const nodesEmpty = await readNodes(page);

    console.log(`- ${name}: building the session`);
    const buildStart = Date.now();
    const built = await page.evaluate(buildFixture, { name, spec });
    const loadMs = Date.now() - buildStart;
    await sleep(1000);
    const nodesLoaded = await readNodes(page);

    const phases = {};
    for (const mode of ['loop', 'song']) {
        console.log(`- ${name}: ${mode} mode, ${seconds} s`);
        await startPlayback(page, mode);
        await sleep(WARMUP_MS);
        const from = await page.evaluate(() => performance.now());
        const samples = await audio.poll(seconds * 1000);
        const to = await page.evaluate(() => performance.now());
        const nodes = await readNodes(page);
        const longTasks = await readLongTasks(page, from, to);
        const steps = await readSteps(page, from, to);
        await stopPlayback(page);
        phases[mode] = { ...summarize(samples), nodes: nodes.count, longTasks: summarizeLongTasks(longTasks), stepCallback: summarizeSteps(steps) };
        await sleep(500);
    }

    console.log(`- ${name}: pitch sweep`);
    await startPlayback(page, 'loop');
    await sleep(WARMUP_MS);
    let isSwept = false;
    const sweepPolling = audio.poll(60000, () => isSwept);
    const sweep = await sweepPitch(page).finally(() => (isSwept = true));
    const sweepAudio = summarize(await sweepPolling);
    const sweepTasks = await readLongTasks(page, sweep.from, sweep.to);
    const sweepSteps = await readSteps(page, sweep.from, sweep.to);
    await stopPlayback(page);
    await sleep(1500);
    const nodesEnd = await readNodes(page);

    if (reloads) {
        throw new Error(`The ${name} page reloaded during the run (the dev server reacting to a file change?); its numbers are not valid.`);
    }
    await context.close();
    return {
        /* Written after the browser closed: a new file under the project makes the dev server push updates. */
        file: built.file,
        spec,
        tracks: built.tracks,
        samplers: built.samplers,
        fileBytes: built.bytes,
        loadMs,
        audioContext,
        nodes: { empty: nodesEmpty.count, loaded: nodesLoaded.count, end: nodesEnd.count, byType: nodesLoaded.byType },
        loop: phases.loop,
        song: phases.song,
        sweep: { renders: sweep.renders, durationMs: sweep.to - sweep.from, ...sweepAudio, longTasks: summarizeLongTasks(sweepTasks), stepCallback: summarizeSteps(sweepSteps), tasks: sweepTasks },
    };
};

/* ---- table ---- */

const fmt = (value, digits = 2) => (value === null || value === undefined || Number.isNaN(value) ? '-' : Number(value).toFixed(digits));

/** Current value, and the previous one with the change when comparing. */
const cell = (current, previous, digits) => {
    if (previous === undefined || previous === null) {
        return fmt(current, digits);
    }
    const change = previous ? ` ${current >= previous ? '+' : ''}${fmt(((current - previous) / previous) * 100, 0)}%` : '';
    return `${fmt(current, digits)} (was ${fmt(previous, digits)}${change})`;
};

const stepCell = (now, was) =>
    now ? `${fmt(now.meanMs, 3)}/${fmt(now.p95Ms, 3)}${was ? ` (was ${fmt(was.meanMs, 3)}/${fmt(was.p95Ms, 3)})` : ''}` : '-';

const printTable = (result, previous) => {
    const rows = [];
    for (const [name, fixture] of Object.entries(result.fixtures)) {
        const before = previous?.fixtures?.[name];
        for (const mode of ['loop', 'song']) {
            const now = fixture[mode];
            const was = before?.[mode];
            rows.push({
                fixture: name,
                mode,
                'renderCap mean': cell(now.renderCapacityMean, was?.renderCapacityMean, 3),
                'renderCap max': cell(now.renderCapacityMax, was?.renderCapacityMax, 3),
                load: cell(now.load, was?.load, 2),
                'cb interval ms': cell(now.callbackIntervalMeanMs, was?.callbackIntervalMeanMs, 2),
                'cb variance': cell(now.callbackIntervalVarianceMean, was?.callbackIntervalVarianceMean, 4),
                nodes: cell(now.nodes, was?.nodes, 0),
                'long tasks': cell(now.longTasks.count, was?.longTasks.count, 0),
                'step ms mean/p95': stepCell(now.stepCallback, was?.stepCallback),
            });
        }
        rows.push({
            fixture: name,
            mode: 'sweep',
            'renderCap mean': cell(fixture.sweep.renderCapacityMean, before?.sweep.renderCapacityMean, 3),
            'renderCap max': cell(fixture.sweep.renderCapacityMax, before?.sweep.renderCapacityMax, 3),
            load: cell(fixture.sweep.load, before?.sweep.load, 2),
            'cb interval ms': cell(fixture.sweep.callbackIntervalMeanMs, before?.sweep.callbackIntervalMeanMs, 2),
            'cb variance': cell(fixture.sweep.callbackIntervalVarianceMean, before?.sweep.callbackIntervalVarianceMean, 4),
            nodes: cell(fixture.nodes.end, before?.nodes.end, 0),
            'step ms mean/p95': stepCell(fixture.sweep.stepCallback, before?.sweep.stepCallback),
            'long tasks': `${cell(fixture.sweep.longTasks.count, before?.sweep.longTasks.count, 0)}, max ${cell(fixture.sweep.longTasks.maxMs, before?.sweep.longTasks.maxMs, 0)} ms`,
        });
    }
    console.log(`\n${result.label} (${result.commit}${result.dirty ? ', dirty' : ''})${previous ? ` compared with ${previous.label} (${previous.commit})` : ''}`);
    console.table(rows);
};

/* ---- main ---- */

const main = async () => {
    const previous = comparePath ? JSON.parse(await readFile(resolve(comparePath), 'utf8')) : null;
    const { hostname } = new URL(url);
    const browser = await chromium.launch({
        /* The full Chromium build: its headless mode is the real browser, and the headless shell ignores the secure-origin flag below. */
        channel: 'chromium',
        headless: !flag('headed'),
        args: [
            '--autoplay-policy=no-user-gesture-required',
            /* The dev host is plain http; AudioWorklet (Tone's BitCrusher) needs a secure context. */
            `--unsafely-treat-insecure-origin-as-secure=${new URL(url).origin}`,
            ...(hostname.endsWith('.test') ? [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`] : []),
        ],
    });

    const result = {
        label,
        commit,
        dirty: !!git('status --porcelain -- ../../src'),
        date: new Date().toISOString(),
        url,
        browser: browser.version(),
        secondsPerMode: seconds,
        latency: latency ?? 'app default',
        fixtures: {},
    };
    try {
        for (const name of fixtureNames) {
            result.fixtures[name] = await runFixture(browser, name);
        }
    } finally {
        await browser.close();
    }

    for (const [name, fixture] of Object.entries(result.fixtures)) {
        if (flag('save-fixtures')) {
            await mkdir(join(here, 'fixtures'), { recursive: true });
            await writeFile(join(here, 'fixtures', `${name}.juicyloops`), Buffer.from(fixture.file, 'base64'));
        }
        delete fixture.file;
    }

    const dir = join(here, 'results');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${label}.json`);
    await writeFile(file, `${JSON.stringify(result, null, 4)}\n`);
    printTable(result, previous);
    console.log(`\nWritten to ${file}`);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
