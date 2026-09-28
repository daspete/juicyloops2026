/**
 * The metronome: a short click on every beat, accented on the downbeat of a bar.
 *
 * It plays straight into the context's destination, never through the master bus, so it is never part of what the
 * master sounds like and never ends up in an export. Offline renders never make one: only the recorder (the live
 * engine's step hook) creates it. Two tiny buffers, made once; every click is a buffer source, fire and forget.
 */

/** The bits of a (standardized) AudioContext the metronome uses. */
export interface ClickContext {
    readonly sampleRate: number;
    readonly currentTime: number;
    readonly destination: AudioNode | { connect?: unknown };
    createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
    createBufferSource(): AudioBufferSourceNode;
    createGain(): GainNode;
}

const CLICK_SECONDS = 0.035;

/** A decaying sine burst; the accent is higher and louder. */
const clickSamples = (sampleRate: number, hz: number, level: number): Float32Array => {
    const length = Math.round(CLICK_SECONDS * sampleRate);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        // A 1 ms fade-in against a click of its own, then an exponential decay.
        const attack = Math.min(1, t / 0.001);
        data[i] = Math.sin(2 * Math.PI * hz * t) * level * attack * Math.exp(-t / 0.008);
    }
    return data;
};

export class Metronome {
    /** Loudness of the clicks, 0..1. */
    level = 0.8;

    private accent: AudioBuffer | null = null;
    private beat: AudioBuffer | null = null;
    private output: GainNode | null = null;
    /** Clicks scheduled and not yet over, so a stop can silence the ones still ahead. */
    private readonly scheduled = new Set<{ source: AudioBufferSourceNode; time: number }>();

    constructor(private readonly context: ClickContext) {}

    /** Schedules one click at an audio-context time. */
    click(time: number, accent: boolean): void {
        const output = this.ensure();
        const source = this.context.createBufferSource();
        source.buffer = accent ? this.accent : this.beat;
        source.connect(output);
        const entry = { source, time };
        this.scheduled.add(entry);
        source.onended = () => {
            this.scheduled.delete(entry);
            source.disconnect();
        };
        source.start(Math.max(time, this.context.currentTime));
    }

    /** Silences every click scheduled after `time` (a stop, a cancelled count-in). */
    cancelAfter(time: number): void {
        for (const entry of this.scheduled) {
            if (entry.time > time) {
                this.scheduled.delete(entry);
                try {
                    entry.source.stop();
                } catch {
                    /* never started or already over */
                }
                entry.source.disconnect();
            }
        }
    }

    /** How many clicks are scheduled and not over yet. */
    get pending(): number {
        return this.scheduled.size;
    }

    private ensure(): GainNode {
        if (!this.output) {
            const rate = this.context.sampleRate;
            const make = (hz: number, level: number) => {
                const samples = clickSamples(rate, hz, level);
                const buffer = this.context.createBuffer(1, samples.length, rate);
                buffer.getChannelData(0).set(samples);
                return buffer;
            };
            this.accent = make(1760, 1);
            this.beat = make(1320, 0.6);
            this.output = this.context.createGain();
            this.output.connect(this.context.destination as AudioNode);
        }
        this.output.gain.value = this.level;
        return this.output;
    }
}
