/**
 * Benchmark sessions for `run.mjs`.
 *
 * A fixture is a small spec (sizes, effects, song layout). `buildFixture` turns it into a real session inside the
 * page: it builds the containers and tracks with the engine's own classes in a scratch `Sequencer`, so every value
 * the spec does not name keeps whatever default the engine code has at that commit (a later change of rack defaults
 * shows up in the numbers, as it would for a new user session). The scratch session is then packed into a
 * `.juicyloops` file and opened through `useSession().openFile`, the same path a user's saved file takes.
 *
 * Patterns are one-step notes on whole steps at full velocity (what `activateEveryNth` makes), each pitched by its
 * step, the same as the tick patterns of the fixtures before notes, so results stay comparable.
 *
 * The sample tracks play a drum loop synthesized here (deterministic, no binary files in the repo), long enough
 * for a pitch change to cost a real `timeStretch`.
 */

/**
 * @typedef {object} FixtureSpec
 * @property {number} containers
 * @property {number} tracks            tracks per container
 * @property {number} samplers          of those, how many are sample tracks (the first ones)
 * @property {{ effect: string, wet: number, every: number, offset?: number }[]} trackEffects
 *     a wet effect on every `every`-th track (counted over the whole session, starting at `offset`)
 * @property {Record<string, number>} busEffects   wet effects on every container bus, by effect
 * @property {{ lanes: number, bars: number, clipBars: number } | null} song
 * @property {number} automation        song automation lanes
 */

/** @type {Record<string, FixtureSpec>} */
export const FIXTURES = {
    small: {
        containers: 1,
        tracks: 8,
        samplers: 3,
        trackEffects: [],
        busEffects: {},
        /* One lane repeating the container, so song mode has something to play. */
        song: { lanes: 1, bars: 8, clipBars: 4 },
        automation: 0,
    },
    medium: {
        containers: 4,
        tracks: 8,
        samplers: 3,
        trackEffects: [
            { effect: 'delay', wet: 0.25, every: 8, offset: 4 },
            { effect: 'chorus', wet: 0.4, every: 16, offset: 5 },
            { effect: 'distortion', wet: 0.3, every: 16, offset: 1 },
        ],
        busEffects: {},
        song: { lanes: 3, bars: 16, clipBars: 4 },
        automation: 0,
    },
    heavy: {
        containers: 8,
        tracks: 16,
        samplers: 5,
        trackEffects: [
            { effect: 'delay', wet: 0.2, every: 8, offset: 6 },
            { effect: 'chorus', wet: 0.4, every: 16, offset: 7 },
            { effect: 'phaser', wet: 0.3, every: 32, offset: 9 },
            { effect: 'bitCrusher', wet: 0.5, every: 64, offset: 2 },
        ],
        busEffects: { reverb: 0.2, delay: 0.15 },
        song: { lanes: 4, bars: 32, clipBars: 4 },
        automation: 6,
    },
};

/**
 * Builds a fixture in the page and opens it as the session. Runs in the browser through `page.evaluate`, so it must
 * not use anything from this module's scope.
 *
 * @param {{ name: string, spec: FixtureSpec }} args
 * @returns {Promise<{ file: string, bytes: number, tracks: number, samplers: number }>} the session file as base64
 */
export async function buildFixture({ name, spec }) {
    /* Vite serves edited modules as `?t=…` URLs; a bare import would make a second, unconnected module instance. */
    const load = (path) => {
        const loaded = performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === path);
        return import(loaded ? loaded.name : path);
    };
    const [{ Sequencer }, { packSession }, { useSession }, { useJuicyLoops }] = await Promise.all([
        load('/src/juicyloops/sequencer.ts'),
        load('/src/juicyloops/sessionFile.ts'),
        load('/src/composables/useSession.ts'),
        load('/src/composables/useJuicyLoops.ts'),
    ]);

    /* ---- a four bar drum loop at the default tempo (about 7 s), 16 bit stereo WAV ---- */
    const { bpm } = useJuicyLoops();
    const rate = 44100;
    const beat = 60 / bpm.value;
    const length = Math.round(16 * beat * rate);
    let seed = 12345;
    const noise = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x3fffffff - 1;
    };
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    const hit = (start, seconds, voice, pan = 0) => {
        const from = Math.round(start * rate);
        const to = Math.min(length, from + Math.round(seconds * rate));
        for (let i = from; i < to; i++) {
            const value = voice((i - from) / rate);
            left[i] += value * (1 - Math.max(0, pan));
            right[i] += value * (1 + Math.min(0, pan));
        }
    };
    let previous = 0;
    const kick = (t) => Math.sin(2 * Math.PI * (50 * t + (100 / 30) * (1 - Math.exp(-30 * t)))) * Math.exp(-6 * t) * 0.9;
    const snare = (t) => (noise() * 0.6 + Math.sin(2 * Math.PI * 185 * t) * 0.4) * Math.exp(-18 * t) * 0.7;
    const hat = (t) => {
        const white = noise();
        const high = white - previous;
        previous = white;
        return high * Math.exp(-60 * t) * 0.35;
    };
    for (let step = 0; step < 64; step++) {
        const at = (step * beat) / 4;
        if (step % 8 === 0 || step % 32 === 22) {
            hit(at, 0.5, kick);
        }
        if (step % 8 === 4) {
            hit(at, 0.3, snare, -0.1);
        }
        if (step % 2 === 0) {
            hit(at, 0.08, hat, 0.3);
        }
    }
    const wav = new DataView(new ArrayBuffer(44 + length * 4));
    const text = (offset, value) => [...value].forEach((char, i) => wav.setUint8(offset + i, char.charCodeAt(0)));
    text(0, 'RIFF');
    wav.setUint32(4, 36 + length * 4, true);
    text(8, 'WAVEfmt ');
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true);
    wav.setUint16(22, 2, true);
    wav.setUint32(24, rate, true);
    wav.setUint32(28, rate * 4, true);
    wav.setUint16(32, 4, true);
    wav.setUint16(34, 16, true);
    text(36, 'data');
    wav.setUint32(40, length * 4, true);
    for (let i = 0; i < length; i++) {
        wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i])) * 0x7fff, true);
        wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i])) * 0x7fff, true);
    }
    const sample = new Blob([wav.buffer], { type: 'audio/wav' });

    /* ---- the session, in a scratch sequencer ---- */
    const scratch = new Sequencer();
    const scale = ['C4', 'D#4', 'F4', 'G4', 'A#4', 'C5', 'D#5', 'G5'];
    const oscillators = ['sine', 'square', 'triangle', 'sawtooth'];
    const containers = [];
    let trackNumber = 0;
    let samplers = 0;
    for (let c = 0; c < spec.containers; c++) {
        const container = c === 0 ? scratch.currentContainer : scratch.addContainer();
        container.name = `Perf ${c + 1}`;
        for (let t = 0; t < spec.tracks; t++, trackNumber++) {
            if (t < spec.samplers) {
                const track = container.addTrack('sampler');
                await track.loadSample(sample, 'perf-drums.wav');
                track.activateEveryNth([4, 8, 2, 16, 4][t % 5]);
                if (t === 2) {
                    track.sliceEvenly(8);
                    track.setNotes(track.notes.map((note) => ({ ...note, note: ['C5', 'C#5', 'D5', 'D#5'][note.start % 4] })));
                }
                samplers++;
            } else {
                const track = container.addTrack('synth');
                track.setOscillatorType(oscillators[(c + t) % oscillators.length]);
                track.setCutsNotes(t % 3 !== 0);
                track.activateEveryNth([2, 3, 4, 8][(c + t) % 4]);
                track.setNotes(track.notes.map((note) => ({ ...note, note: scale[(note.start + t + c) % scale.length] })));
            }
            const track = container.tracks[container.tracks.length - 1];
            track.setVolume(-6 - (t % 4) * 2);
            track.setPan(((t % 5) - 2) * 0.2);
            for (const { effect, wet, every, offset = 0 } of spec.trackEffects) {
                if ((trackNumber - offset) % every === 0) {
                    track.effects.setParam(effect, 'wet', wet);
                }
            }
        }
        for (const [effect, wet] of Object.entries(spec.busEffects)) {
            container.bus.effects.setParam(effect, 'wet', wet);
        }
        containers.push(container);
    }

    const song = scratch.song;
    if (spec.song) {
        const { lanes, bars, clipBars } = spec.song;
        /* A song bar is `SONG_STEPS_PER_BAR` (16) steps; clips rotate through the containers, lanes play in parallel. */
        while (song.lanes.length < lanes) {
            song.addLane();
        }
        for (let lane = 0; lane < lanes; lane++) {
            for (let bar = 0, clip = 0; bar < bars; bar += clipBars, clip++) {
                const container = containers[(lane * 2 + clip) % containers.length];
                song.addClip(song.lanes[lane].id, container.id, bar * 16, clipBars * 16);
            }
        }
    }
    const end = spec.song ? spec.song.bars * 16 : 64;
    const curve = (low, high) => [
        { step: 0, value: low },
        { step: end / 2, value: high },
        { step: end, value: low },
    ];
    const targets = [
        () => [{ kind: 'master' }, 'volume', curve(0.8, 0.9)],
        () => [{ kind: 'container', containerId: containers[0].id }, 'fx.reverb.wet', curve(0.1, 0.4)],
        () => [{ kind: 'container', containerId: containers[1 % containers.length].id }, 'fx.delay.wet', curve(0.05, 0.3)],
        () => [{ kind: 'container', containerId: containers[2 % containers.length].id }, 'pan', curve(0.3, 0.7)],
        () => [{ kind: 'track', containerId: containers[0].id, trackId: containers[0].tracks[spec.samplers].id }, 'envelope.release', curve(0.2, 0.6)],
        () => [{ kind: 'track', containerId: containers[1 % containers.length].id, trackId: containers[1 % containers.length].tracks[spec.samplers + 1].id }, 'volume', curve(0.6, 0.85)],
    ];
    for (let i = 0; i < spec.automation; i++) {
        const [target, param, points] = targets[i % targets.length]();
        song.addAutomation(target, param).points.push(...points);
    }

    const session = scratch.capture();
    session.currentContainerId = containers[0].id;
    const file = packSession({ name: `perf-${name}`, bpm: bpm.value, session });
    scratch.dispose();

    /* ---- open it like a user would ---- */
    const result = await useSession().openFile(new File([file], `perf-${name}.juicyloops`));
    if (!result.ok) {
        throw new Error(`Could not open fixture ${name}: ${JSON.stringify(result)}`);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { file: btoa(binary), bytes: bytes.length, tracks: trackNumber, samplers };
}
