/**
 * A/B listening aid for the sample stretch engines: `node scripts/perf/stretch-ab.mjs [files.wav…] [options]`
 * (from `juicyloops/frontend`, Node 22.18+ / 24, which loads the TypeScript sources directly).
 *
 * For every input WAV and every setting it writes what a sample track would play, one file per engine:
 *
 *   <out>/<name>_original.wav
 *   <out>/<name>_wsola_<setting>.wav              WSOLA (`src/juicyloops/stretch.ts`), the fallback
 *   <out>/<name>_signalsmith_<setting>.wav        Signalsmith Stretch, what the app uses
 *   <out>/<name>_transpose_<setting>.wav          Signalsmith's own transposition (not used, for comparison)
 *
 * Like `SampleTrack`, the first two stretch by pitch ratio / speed and are then played at the pitch ratio
 * (linear interpolation, as an `AudioBufferSourceNode` with a `playbackRate` does), so the length follows the
 * speed and the pitch follows the semitones. `transpose` asks Signalsmith for the pitch shift directly and
 * stretches by 1 / speed only.
 *
 * Without input files it makes three test signals (a drum loop, a 55 Hz bass line and a harmonic tone), so the
 * script can be tried at once; real drums, a vocal and a bass tell far more.
 *
 * Options:
 *   --out <dir>          output directory (default scripts/perf/stretch-ab-out, gitignored)
 *   --settings <list>    comma separated; `+7st`, `-7st`, `0.5x`, `2x` or both as `+7st@2x`
 *                        (default +7st,-7st,0.5x,2x). Speed as in the app: 2x plays twice as fast.
 *
 * Input WAVs: PCM 8/16/24/32-bit or 32/64-bit float, any channel count and rate. Output: 32-bit float WAV.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateSignalsmith } from '../../src/juicyloops/dsp/signalsmith.ts';
import { timeStretch } from '../../src/juicyloops/stretch.ts';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '../..');

/* ---- arguments ---- */

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index < 0) {
        return fallback;
    }
    const [, value] = args.splice(index, 2);
    return value;
};
const outDir = resolve(option('--out', join(here, 'stretch-ab-out')));
const settings = option('--settings', '+7st,-7st,0.5x,2x')
    .split(',')
    .map((text) => {
        const match = /^(?:([+-]?\d+(?:\.\d+)?)st)?@?(?:(\d+(?:\.\d+)?)x)?$/.exec(text.trim());
        if (!match || (!match[1] && !match[2])) {
            throw new Error(`Cannot read setting "${text}"; use e.g. +7st, 0.5x or -7st@2x`);
        }
        return { label: text.trim(), semitones: Number(match[1] ?? 0), speed: Number(match[2] ?? 1) };
    });
const inputs = args;

/* ---- WAV ---- */

const readWav = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
        throw new Error('not a RIFF/WAVE file');
    }
    let format = null;
    for (let at = 12; at + 8 <= bytes.length; ) {
        const id = tag(at);
        const size = view.getUint32(at + 4, true);
        const body = at + 8;
        if (id === 'fmt ') {
            let code = view.getUint16(body, true);
            if (code === 0xfffe) {
                code = view.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE: the sub-format GUID starts with the code
            }
            format = { code, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
        } else if (id === 'data' && format) {
            const { code, channels: count, bits } = format;
            const width = bits / 8;
            const length = Math.floor(Math.min(size, bytes.length - body) / (width * count));
            const channels = Array.from({ length: count }, () => new Float32Array(length));
            const read =
                code === 3
                    ? bits === 64
                        ? (p) => view.getFloat64(p, true)
                        : (p) => view.getFloat32(p, true)
                    : bits === 8
                      ? (p) => (view.getUint8(p) - 128) / 128
                      : bits === 16
                        ? (p) => view.getInt16(p, true) / 32768
                        : bits === 24
                          ? (p) => ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) / 8388608)
                          : (p) => view.getInt32(p, true) / 2147483648;
            if (code !== 1 && code !== 3) {
                throw new Error(`unsupported WAV format code ${code}`);
            }
            for (let i = 0; i < length; i++) {
                for (let c = 0; c < count; c++) {
                    channels[c][i] = read(body + (i * count + c) * width);
                }
            }
            return { sampleRate: format.sampleRate, channels };
        }
        at = body + size + (size & 1);
    }
    throw new Error('no fmt/data chunk');
};

const writeWav = (channels, sampleRate) => {
    const count = channels.length;
    const length = channels[0].length;
    const data = length * count * 4;
    const view = new DataView(new ArrayBuffer(44 + data));
    const tag = (at, text) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
    tag(0, 'RIFF');
    view.setUint32(4, 36 + data, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, count, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * count * 4, true);
    view.setUint16(32, count * 4, true);
    view.setUint16(34, 32, true);
    tag(36, 'data');
    view.setUint32(40, data, true);
    for (let i = 0; i < length; i++) {
        for (let c = 0; c < count; c++) {
            view.setFloat32(44 + (i * count + c) * 4, channels[c][i], true);
        }
    }
    return new Uint8Array(view.buffer);
};

/* ---- test signals ---- */

const demoSignals = (sampleRate = 48000) => {
    const seconds = 4;
    const length = seconds * sampleRate;
    let seed = 1;
    const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const drums = new Float32Array(length);
    for (let beat = 0; beat < seconds * 4; beat++) {
        const start = Math.round((beat * sampleRate) / 4);
        for (let i = 0; i < 0.3 * sampleRate && start + i < length; i++) {
            const t = i / sampleRate;
            const kick = beat % 2 === 0 ? 0.7 * Math.sin(2 * Math.PI * (50 * t + 60 * (1 - Math.exp(-t / 0.02)) * 0.02)) * Math.exp(-t / 0.12) : 0;
            const hat = 0.25 * noise() * Math.exp(-t / (beat % 2 ? 0.05 : 0.008));
            drums[start + i] += kick + hat;
        }
    }
    const notes = [55, 55, 82.41, 73.42];
    const bass = Float32Array.from({ length }, (_, i) => {
        const t = i / sampleRate;
        const note = Math.floor(t);
        const local = t - note;
        const f = notes[note % notes.length];
        const saw = [1, 2, 3, 4, 5].reduce((sum, k) => sum + Math.sin(2 * Math.PI * f * k * t) / k, 0);
        return 0.35 * saw * Math.min(1, local / 0.005) * Math.exp(-local / 0.6);
    });
    const tone = Float32Array.from({ length }, (_, i) => 0.2 * [1, 2, 3, 4, 5, 6, 7, 8].reduce((sum, k) => sum + Math.sin((2 * Math.PI * 220 * k * i) / sampleRate) / k, 0));
    return [
        { name: 'demo-drums', sampleRate, channels: [drums, drums.slice()] },
        { name: 'demo-bass', sampleRate, channels: [bass] },
        { name: 'demo-tone', sampleRate, channels: [tone] },
    ];
};

/* ---- engines ---- */

const signalsmith = await instantiateSignalsmith(await readFile(join(frontend, 'src/juicyloops/dsp/wasm/stretch.wasm')));
const ratioOf = (semitones) => 2 ** (semitones / 12);

/** `playbackRate` on an AudioBufferSourceNode: linear interpolation. */
const playAtRate = (channel, rate) => {
    if (rate === 1) {
        return channel;
    }
    const out = new Float32Array(Math.floor((channel.length - 1) / rate));
    for (let i = 0; i < out.length; i++) {
        const at = i * rate;
        const k = Math.floor(at);
        out[i] = channel[k] + (channel[k + 1] - channel[k]) * (at - k);
    }
    return out;
};

const variants = {
    wsola: ({ channels, sampleRate }, { semitones, speed }) => timeStretch(channels, sampleRate, ratioOf(semitones) / speed).map((c) => playAtRate(c, ratioOf(semitones))),
    signalsmith: ({ channels, sampleRate }, { semitones, speed }) =>
        signalsmith.stretch(channels, sampleRate, ratioOf(semitones) / speed).map((c) => playAtRate(c, ratioOf(semitones))),
    transpose: ({ channels, sampleRate }, { semitones, speed }) => signalsmith.stretch(channels, sampleRate, 1 / speed, semitones),
};

/* ---- run ---- */

const sources = inputs.length
    ? await Promise.all(inputs.map(async (path) => ({ name: basename(path, extname(path)), ...readWav(await readFile(path)) })))
    : demoSignals();

await mkdir(outDir, { recursive: true });
for (const source of sources) {
    await writeFile(join(outDir, `${source.name}_original.wav`), writeWav(source.channels, source.sampleRate));
    const seconds = (source.channels[0].length / source.sampleRate).toFixed(2);
    for (const setting of settings) {
        const row = [];
        for (const [variant, run] of Object.entries(variants)) {
            const started = performance.now();
            const out = run(source, setting);
            row.push(`${variant} ${(performance.now() - started).toFixed(0)} ms`);
            await writeFile(join(outDir, `${source.name}_${variant}_${setting.label}.wav`), writeWav(out, source.sampleRate));
        }
        console.log(`${source.name} (${seconds} s, ${source.channels.length} ch) ${setting.label}: ${row.join(', ')}`);
    }
}
console.log(`Written to ${outDir}`);
