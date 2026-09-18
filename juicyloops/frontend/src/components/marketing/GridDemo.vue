<script setup lang="ts">
/**
 * The hero: a four-row, one-bar step grid that really plays. It is rendered on the server with its
 * preset pattern, then hydrated; sound comes from a few Web Audio oscillators and noise bursts,
 * no engine needed, so the page stays light.
 */
import { onBeforeUnmount, reactive, ref } from 'vue';
import { useHeroPulse } from '@/composables/useHeroPulse';

const { pulse } = useHeroPulse();

const STEPS = 16;
const BPM = 118;

interface Row {
    key: 'blip' | 'hat' | 'snare' | 'kick';
    label: string;
    color: string;
    steps: boolean[];
}

const on = (...steps: number[]) => Array.from({ length: STEPS }, (_, i) => steps.includes(i));

const rows = reactive<Row[]>([
    { key: 'blip', label: 'Synth', color: 'var(--jl-synth)', steps: on(0, 3, 6, 10, 11, 14) },
    { key: 'hat', label: 'Hats', color: 'var(--jl-brand)', steps: on(2, 6, 10, 14, 15) },
    { key: 'snare', label: 'Snare', color: 'var(--jl-mic)', steps: on(4, 12) },
    { key: 'kick', label: 'Kick', color: 'var(--jl-sampler)', steps: on(0, 4, 8, 12, 14) },
]);

/* One bar of a minor pentatonic riff for the synth row, one note per step. */
const BLIP_NOTES = [220, 261.6, 293.7, 329.6, 392, 440, 523.3, 587.3, 659.3, 392, 329.6, 293.7, 261.6, 220, 196, 174.6];

const playing = ref(false);
const currentStep = ref(-1);

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let timer: number | undefined;
let frame = 0;
let nextTime = 0;
let nextStep = 0;
let queue: { step: number; time: number }[] = [];

const ensureContext = (): AudioContext => {
    if (!context) {
        context = new AudioContext();
        master = context.createGain();
        master.gain.value = 0.55;
        master.connect(context.destination);

        const seconds = 1;
        noise = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i += 1) {
            data[i] = Math.random() * 2 - 1;
        }
    }
    return context;
};

const envelope = (ctx: AudioContext, at: number, peak: number, decay: number): GainNode => {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    gain.connect(master!);
    return gain;
};

const burst = (ctx: AudioContext, at: number, filterType: BiquadFilterType, frequency: number, peak: number, decay: number) => {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = 0.8;
    source.connect(filter).connect(envelope(ctx, at, peak, decay));
    source.start(at);
    source.stop(at + decay + 0.05);
};

const voices: Record<Row['key'], (ctx: AudioContext, at: number, step: number) => void> = {
    kick(ctx, at) {
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(160, at);
        osc.frequency.exponentialRampToValueAtTime(42, at + 0.18);
        osc.connect(envelope(ctx, at, 1, 0.34));
        osc.start(at);
        osc.stop(at + 0.4);
    },
    snare(ctx, at) {
        burst(ctx, at, 'bandpass', 1900, 0.7, 0.17);
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(210, at);
        osc.frequency.exponentialRampToValueAtTime(140, at + 0.08);
        osc.connect(envelope(ctx, at, 0.5, 0.1));
        osc.start(at);
        osc.stop(at + 0.15);
    },
    hat(ctx, at, step) {
        burst(ctx, at, 'highpass', 7200, step % 4 === 2 ? 0.3 : 0.18, step === 15 ? 0.18 : 0.05);
    },
    blip(ctx, at, step) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = BLIP_NOTES[step];
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2600, at);
        filter.frequency.exponentialRampToValueAtTime(500, at + 0.22);
        filter.Q.value = 6;
        osc.connect(filter).connect(envelope(ctx, at, 0.28, 0.24));
        osc.start(at);
        osc.stop(at + 0.3);
    },
};

const stepSeconds = () => 60 / BPM / 4;

const schedule = () => {
    const ctx = ensureContext();
    while (nextTime < ctx.currentTime + 0.12) {
        for (const row of rows) {
            if (row.steps[nextStep]) {
                voices[row.key](ctx, nextTime, nextStep);
            }
        }
        queue.push({ step: nextStep, time: nextTime });
        nextTime += stepSeconds();
        nextStep = (nextStep + 1) % STEPS;
    }
};

const paint = () => {
    const ctx = context;
    if (!ctx) {
        return;
    }
    while (queue.length > 1 && queue[1].time <= ctx.currentTime) {
        queue.shift();
    }
    if (queue.length && queue[0].time <= ctx.currentTime) {
        if (currentStep.value !== queue[0].step) {
            /* Kicks and snares hit the hero waveform harder than hats. */
            const step = queue[0].step;
            const heavy = rows.some((row) => (row.key === 'kick' || row.key === 'snare') && row.steps[step]);
            const any = rows.some((row) => row.steps[step]);
            if (any) {
                pulse(heavy ? 1 : 0.35);
            }
        }
        currentStep.value = queue[0].step;
    }
    frame = requestAnimationFrame(paint);
};

const start = async () => {
    const ctx = ensureContext();
    await ctx.resume();
    queue = [];
    nextStep = 0;
    nextTime = ctx.currentTime + 0.05;
    playing.value = true;
    schedule();
    timer = window.setInterval(schedule, 25);
    frame = requestAnimationFrame(paint);
};

const stop = () => {
    playing.value = false;
    currentStep.value = -1;
    window.clearInterval(timer);
    cancelAnimationFrame(frame);
    queue = [];
};

const toggle = () => (playing.value ? stop() : start());

const tap = (row: Row, step: number) => {
    row.steps[step] = !row.steps[step];
    if (row.steps[step] && !playing.value) {
        const ctx = ensureContext();
        ctx.resume().then(() => voices[row.key](ctx, ctx.currentTime + 0.01, step));
    }
};

const clear = () => rows.forEach((row) => row.steps.fill(false));

onBeforeUnmount(() => {
    stop();
    context?.close();
    context = null;
});
</script>

<template>
    <div class="demo" :data-playing="playing" :style="{ '--step': currentStep }">
        <div class="demo-bar">
            <button type="button" class="demo-play" :aria-pressed="playing" :aria-label="playing ? 'Stop' : 'Play'" @click="toggle">
                <svg v-if="playing" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
            </button>
            <span class="demo-bpm"
                ><b>{{ BPM }}</b> bpm</span
            >
            <span class="demo-hint">{{ playing ? 'tap steps while it runs' : 'press play, then tap steps' }}</span>
            <button type="button" class="demo-clear" @click="clear">Clear</button>
        </div>

        <div class="demo-grid" role="group" aria-label="One bar, sixteen steps">
            <div class="demo-ruler" aria-hidden="true">
                <span></span>
                <span v-for="beat in 4" :key="beat">{{ beat }}</span>
            </div>
            <div v-for="row in rows" :key="row.key" class="demo-row" :style="{ '--c': row.color }">
                <span class="demo-label">{{ row.label }}</span>
                <button
                    v-for="(active, step) in row.steps"
                    :key="step"
                    type="button"
                    class="demo-step"
                    :data-on="active"
                    :data-beat="step % 4 === 0"
                    :data-now="step === currentStep"
                    :style="{ '--i': step }"
                    :aria-pressed="active"
                    :aria-label="`${row.label} step ${step + 1}`"
                    @click="tap(row, step)"
                ></button>
            </div>
            <i class="demo-head" aria-hidden="true"></i>
        </div>
    </div>
</template>
