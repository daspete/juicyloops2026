/**
 * Browser checks for the piano roll's live key lighting (`RollLiveKeys`), with the fake Web MIDI of `fakeMidi.mjs`.
 *
 *     node scripts/midi/rollKeys.mjs [--url http://juicyloops.test/app] [--shots <dir>] [--headed]
 *
 * Runs against the dev server. Opens a synth track's roll: a note-on lights its key and row, a note-off clears them, a
 * key released under the sustain pedal stays lit (dimmer) until the pedal comes up, the note bars are not re-rendered
 * by any of it. A sampler roll lights the slice row the key plays (keys past the last slice light the last one). With
 * `--shots`, screenshots in the dark and the light theme, on a desktop and a phone viewport. Exit code 1 when a check
 * fails.
 */
import { createRequire } from 'node:module';
import { installFakeMidi, noteOff, noteOn, sendMidi, sustain } from './fakeMidi.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
};
const url = option('url', 'http://juicyloops.test/app');
const shots = option('shots', null);
const headed = args.includes('--headed');
const { hostname } = new URL(url);

const results = [];
const check = (pass, name, detail = '') => {
    results.push({ pass: pass ? 'ok' : 'FAIL', check: name, detail: String(detail) });
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` · ${detail}`}`);
    if (!pass) {
        process.exitCode = 1;
    }
};

const openStudio = async (browser, viewport) => {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (error) => console.error('[page error]', error.message));
    await installFakeMidi(page);
    /* Skip the studio splash (src/splash/studio-splash.html): it is shown once per tab unless this flag is set. */
    await page.addInitScript(() => sessionStorage.setItem('juicyloops:splash', 'skip'));
    await page.goto(url, { waitUntil: 'load' });
    await page.locator('.modecard[data-mode="pro"]').click({ timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('.welcome'));
    await page.evaluate(async () => {
        const load = (path) => {
            const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path);
            return import(loaded ? loaded.name : path);
        };
        const { useJuicyLoops } = await load('/src/composables/useJuicyLoops.ts');
        const { useWorkspace } = await load('/src/composables/useWorkspace.ts');
        const { useMidi } = await load('/src/composables/useMidi.ts');
        const midi = useMidi();
        await midi.enable();
        window.__jlk = { jl: useJuicyLoops(), workspace: useWorkspace(), midi };
    });
    return page;
};

/** A synth track with a few notes around C5, so the roll opens there. */
const addSynth = (page) =>
    page.evaluate(async () => {
        const { jl } = window.__jlk;
        const created = jl.addTrack('synth');
        const track = jl.tracks.value.find((candidate) => candidate.id === created.id);
        track.addNotes([
            { note: 'C5', start: 0, length: 2, velocity: 1 },
            { note: 'E5', start: 4, length: 2, velocity: 0.8 },
            { note: 'G5', start: 8, length: 4, velocity: 0.6 },
            { note: 'C5', start: 12, length: 2, velocity: 0.9 },
        ]);
        await track.whenReady();
        return { id: track.id, index: jl.tracks.value.indexOf(track) };
    });

/** A sampler with a sample cut into four slices. */
const addSampler = (page) =>
    page.evaluate(async () => {
        const { jl } = window.__jlk;
        const rate = 44100;
        const frames = rate;
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
            view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 0.3 * 32767), true);
        }
        const created = jl.addTrack('sampler');
        const track = jl.tracks.value.find((candidate) => candidate.id === created.id);
        await track.loadSample(new Blob([buffer], { type: 'audio/wav' }), 'slices.wav');
        track.sliceEvenly(4);
        track.addNotes([
            { note: 'C5', start: 0, length: 1, velocity: 1 },
            { note: 'C#5', start: 4, length: 1, velocity: 1 },
            { note: 'D5', start: 8, length: 1, velocity: 1 },
        ]);
        await track.whenReady();
        return { id: track.id, index: jl.tracks.value.indexOf(track) };
    });

const armOnly = (page, id) =>
    page.evaluate((trackId) => {
        const { jl, workspace } = window.__jlk;
        for (const track of jl.tracks.value) {
            track.setArmed(track.id === trackId);
        }
        workspace.selectTrack(trackId);
    }, id);

const openRoll = async (page, index) => {
    await page.locator('.track').nth(index).locator('button.tool', { hasText: 'Notes' }).click();
    await page.locator('.proll').waitFor();
    await page.waitForTimeout(250);
};

const closeRoll = async (page) => {
    await page.locator('.fwin', { has: page.locator('.proll') }).getByRole('button', { name: 'Close window' }).click();
    await page.locator('.proll').waitFor({ state: 'detached' });
};

/** What the roll lights now: the lit keys (label, state), whether each band sits on the row of its key, and the key's colour. */
const lit = (page) =>
    page.evaluate(() => {
        const keys = [...document.querySelectorAll('.proll-key-live')];
        const bands = [...document.querySelectorAll('.proll-live-row')];
        const rows = [...document.querySelectorAll('.proll-key')];
        return {
            keys: keys.map((key) => {
                const box = key.getBoundingClientRect();
                const row = rows.find((candidate) => Math.abs(candidate.getBoundingClientRect().top - box.top) < 1);
                return { label: key.textContent.trim(), state: key.dataset.state, row: row?.textContent.trim() ?? null, background: getComputedStyle(key).backgroundColor };
            }),
            bands: bands.map((band) => {
                const box = band.getBoundingClientRect();
                const key = keys.find((candidate) => Math.abs(candidate.getBoundingClientRect().top - box.top) < 1);
                return { key: key?.textContent.trim() ?? null, state: band.dataset.state };
            }),
        };
    });

const summary = (state) => `keys ${state.keys.map((key) => `${key.label}:${key.state}${key.row === key.label ? '' : `(row ${key.row})`}`).join(' ') || 'none'}; bands ${state.bands.map((band) => `${band.key}:${band.state}`).join(' ') || 'none'}`;

/** Counts DOM mutations of the note bars while `action` runs: lighting keys must not re-render them. */
const noteMutations = async (page, action) => {
    await page.evaluate(() => {
        const body = document.querySelector('.proll-body');
        window.__noteMutations = 0;
        window.__noteObserver = new MutationObserver((records) => {
            for (const record of records) {
                const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                if (target?.closest('.proll-note') || [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1 && node.matches('.proll-note'))) {
                    window.__noteMutations++;
                }
            }
        });
        window.__noteObserver.observe(body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await action();
    return page.evaluate(() => {
        window.__noteObserver.disconnect();
        return window.__noteMutations;
    });
};

const setTheme = (page, dark) => page.evaluate((isDark) => document.documentElement.classList.toggle('dark', isDark), dark);

const shoot = async (page, name) => {
    if (shots) {
        await page.mouse.move(5, 895);
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${shots}/${name}.png` });
    }
};

const main = async () => {
    const browser = await chromium.launch({
        headless: !headed,
        args: ['--autoplay-policy=no-user-gesture-required', ...(hostname.endsWith('.test') ? [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`] : [])],
    });
    try {
        /* ---- desktop: synth roll ---- */
        const page = await openStudio(browser, { width: 1400, height: 900 });
        const synth = await addSynth(page);
        await armOnly(page, synth.id);
        await openRoll(page, synth.index);
        let state = await lit(page);
        check(state.keys.length === 0 && state.bands.length === 0, 'synth roll: nothing lit before a key', summary(state));

        const mutations = await noteMutations(page, async () => {
            await sendMidi(page, noteOn(72));
            await sendMidi(page, noteOn(76));
            await page.waitForTimeout(50);
            state = await lit(page);
        });
        check(
            state.keys.length === 2 && state.keys.every((key) => key.state === 'held' && key.row === key.label) && ['C5', 'E5'].every((label) => state.keys.some((key) => key.label === label)),
            'note-on lights the key (on its own row) in the key column',
            summary(state),
        );
        check(state.bands.length === 2 && state.bands.every((band) => band.key && band.state === 'held'), 'note-on lights its row across the notes area', summary(state));
        check(mutations === 0, 'lighting keys does not re-render the note bars', `${mutations} note mutations`);
        for (const dark of [true, false]) {
            await setTheme(page, dark);
            await shoot(page, `synth-held-${dark ? 'dark' : 'light'}`);
        }
        await setTheme(page, true);

        await sendMidi(page, noteOff(76));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 1 && state.keys[0].label === 'C5', 'note-off clears its key, the other stays', summary(state));
        await sendMidi(page, noteOff(72));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 0 && state.bands.length === 0, 'the last note-off clears everything', summary(state));

        // Sustain: a key released under the pedal stays lit, dimmer; pedal-up clears it.
        await sendMidi(page, sustain(true));
        await sendMidi(page, noteOn(69));
        await sendMidi(page, noteOn(72));
        await sendMidi(page, noteOff(69));
        await page.waitForTimeout(50);
        state = await lit(page);
        const a4 = state.keys.find((key) => key.label === 'A4');
        const c5 = state.keys.find((key) => key.label === 'C5');
        check(a4?.state === 'sustained' && c5?.state === 'held' && a4.background !== c5.background, 'a key released under the pedal stays lit, dimmer', `${summary(state)}; held ${c5?.background}, sustained ${a4?.background}`);
        check(state.bands.find((band) => band.key === 'A4')?.state === 'sustained', 'its row band is dimmer too', summary(state));
        for (const dark of [true, false]) {
            await setTheme(page, dark);
            await shoot(page, `synth-sustain-${dark ? 'dark' : 'light'}`);
        }
        await setTheme(page, true);
        await sendMidi(page, noteOff(72));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 2 && state.keys.every((key) => key.state === 'sustained'), 'both ring on the pedal after their keys came up', summary(state));
        await sendMidi(page, sustain(false));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 0 && state.bands.length === 0, 'pedal up clears them', summary(state));

        // Scheduled pattern notes do not light keys.
        await page.evaluate(() => window.__jlk.jl.play());
        await page.waitForTimeout(1200);
        state = await lit(page);
        await page.evaluate(() => window.__jlk.jl.stop());
        check(state.keys.length === 0, 'the pattern playing lights nothing', summary(state));

        // Another track's keys do not light this roll: arm a second synth only, the selected one stays this roll's track.
        const second = await addSynth(page);
        await page.evaluate(
            ([other, own]) => {
                const { jl, workspace } = window.__jlk;
                for (const track of jl.tracks.value) {
                    track.setArmed(track.id === other);
                }
                workspace.selectTrack(own);
            },
            [second.id, synth.id],
        );
        await sendMidi(page, noteOn(74));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 1 && state.keys[0].label === 'D5', 'the selected track (playing live beside the armed one) lights its roll', summary(state));
        await page.evaluate((own) => window.__jlk.workspace.selectTrack(own), second.id);
        await sendMidi(page, noteOff(74));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 0, 'released after the selection moved: its key goes dark', summary(state));
        await page.evaluate((id) => window.__jlk.jl.removeTrack(id), second.id);
        await closeRoll(page);

        /* ---- desktop: sampler roll (slices) ---- */
        const sampler = await addSampler(page);
        await armOnly(page, sampler.id);
        await openRoll(page, sampler.index);
        await sendMidi(page, noteOn(73));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 1 && state.keys[0].label === 'S2' && state.keys[0].row === 'S2', 'sampler roll: key 73 lights slice 2', summary(state));
        await sendMidi(page, noteOn(90));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 2 && state.keys.some((key) => key.label === 'S4'), 'a key past the last slice lights the slice it plays (the last)', summary(state));
        for (const dark of [true, false]) {
            await setTheme(page, dark);
            await shoot(page, `sampler-${dark ? 'dark' : 'light'}`);
        }
        await sendMidi(page, noteOff(73));
        await sendMidi(page, noteOff(90));
        await page.waitForTimeout(50);
        state = await lit(page);
        check(state.keys.length === 0 && state.bands.length === 0, 'sampler roll: note-offs clear the slices', summary(state));
        await page.close();

        /* ---- phone: the roll fills the screen ---- */
        const phone = await openStudio(browser, { width: 390, height: 844 });
        const phoneSynth = await addSynth(phone);
        await armOnly(phone, phoneSynth.id);
        await openRoll(phone, phoneSynth.index);
        await sendMidi(phone, sustain(true));
        await sendMidi(phone, noteOn(69));
        await sendMidi(phone, noteOff(69));
        await sendMidi(phone, noteOn(72));
        await phone.waitForTimeout(50);
        state = await lit(phone);
        check(state.keys.length === 2 && state.bands.length === 2, 'phone: keys and rows light up', summary(state));
        for (const dark of [true, false]) {
            await setTheme(phone, dark);
            await shoot(phone, `phone-${dark ? 'dark' : 'light'}`);
        }
        await sendMidi(phone, noteOff(72));
        await sendMidi(phone, sustain(false));
        await phone.close();
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
