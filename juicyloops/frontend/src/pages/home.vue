<script setup lang="ts">
/** The marketing page. Prerendered at build time; the grid in the hero plays once the page is hydrated. */
import { RouterLink } from 'vue-router';
import GridDemo from '@/components/marketing/GridDemo.vue';

const JUICE = [
    {
        key: 'synth',
        label: 'Synth',
        color: 'var(--jl-synth)',
        line: 'Draw it.',
        text: 'Notes on a piano roll, a waveform to pick, an envelope to shape. Every note carries its own velocity and length.',
        steps: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0],
    },
    {
        key: 'sampler',
        label: 'Sampler',
        color: 'var(--jl-sampler)',
        line: 'Chop it.',
        text: 'Drop in any audio file, trim it, flip it backwards, put it on the grid. The sample travels inside your session file.',
        steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0],
    },
    {
        key: 'mic',
        label: 'Mic',
        color: 'var(--jl-mic)',
        line: 'Say it.',
        text: 'Your voice, a clap, the kitchen table. It becomes a track like any other, effects and all, and never leaves your device.',
        steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    },
];

const FLOW = [
    {
        beat: '1',
        title: 'Loop',
        text: 'Tap steps on a one-bar grid. Give a track its own length to make polyrhythms, and the ghost steps show you where it repeats.',
    },
    {
        beat: '2',
        title: 'Arrange',
        text: 'Group tracks into containers, then drag them onto the song timeline as clips. Move them, stretch them, cut them in half.',
    },
    {
        beat: '3',
        title: 'Mix and automate',
        text: 'Effects on each track, on each group, and on the master. Any knob can ride a curve, per step inside a loop or across the whole song.',
    },
];

/* The rack shows each effect as a module with one knob; the knob angles are fixed so both sides draw the same. */
const EFFECTS = [
    { label: 'AutoFilter', angle: -80 },
    { label: 'BitCrusher', angle: 35 },
    { label: 'Chorus', angle: -20 },
    { label: 'Compressor', angle: 95 },
    { label: 'Delay', angle: 10 },
    { label: 'Distortion', angle: 120 },
    { label: 'Equalizer', angle: -45 },
    { label: 'Limiter', angle: 70 },
    { label: 'Phaser', angle: -110 },
    { label: 'Reverb', angle: 50 },
    { label: 'Tremolo', angle: -5 },
    { label: 'Vibrato', angle: 25 },
];

/*
 * Three waves behind the hero. Each path spans two screen widths and repeats exactly once per
 * width, so sliding it by half its length loops without a seam. Whole cycles per width keep it periodic.
 */
const HERO_WAVES = [
    { cycles: 2, amplitude: 70, phase: 0, speed: 26 },
    { cycles: 3, amplitude: 45, phase: 1.3, speed: 19 },
    { cycles: 1, amplitude: 90, phase: 2.6, speed: 34 },
].map((wave) => {
    const width = 1200;
    const height = 400;
    const points: string[] = [];
    for (let x = 0; x <= width * 2; x += 10) {
        const t = (x / width) * Math.PI * 2 * wave.cycles + wave.phase;
        const y = height / 2 + Math.sin(t) * wave.amplitude + Math.sin(t * 2.5) * wave.amplitude * 0.25;
        points.push(`${x},${y.toFixed(1)}`);
    }
    return { d: `M${points.join(' L')}`, speed: wave.speed };
});

/* Bar heights of the waveform under the closing section, in percent; fixed so the server and the browser draw the same. */
const WAVE = [
    37, 46, 61, 60, 65, 56, 40, 33, 20, 24, 28, 42, 62, 81, 78, 76, 70, 58, 39, 26, 30, 22, 39, 40, 44, 45, 44, 45, 30, 30, 27, 23, 25, 19, 19, 21, 26, 23, 22,
    26, 25, 23, 28, 26, 22, 30, 37, 49, 55, 54, 61, 44, 38, 33, 20, 26, 30, 53, 70, 80, 74, 60, 48, 35, 28, 33, 41, 52, 66, 72, 58, 44, 31, 24, 29, 38, 47, 56,
    63, 51,
];

const DETAILS = [
    { title: 'Quick or Pro', text: 'Start with just the grid. Switch to Pro for the arranger, mixer and automation whenever you feel like it.' },
    { title: 'Undo everything', text: 'Every tap, drag and knob turn is one step back. Ctrl+Z as deep as you like, Ctrl+Y forward again.' },
    { title: 'One file, all of it', text: 'Save the session to your disk as a single file: tracks, samples, recordings, automation. Open it on any machine.' },
    { title: 'Nothing to install', text: 'No account, no download, no plugins. It runs in the browser you already have, on a phone too.' },
    { title: 'Light or dark', text: 'Follows your system, or flip it yourself. The colours of the tracks stay the same either way.' },
    { title: 'Keyboard first', text: 'Space plays and stops, Ctrl+S saves, Ctrl+O opens. Hold a button to repeat it, the app keeps up.' },
];
</script>

<template>
    <main class="mk-home">
        <section class="mk-hero">
            <svg class="mk-hero-wave" viewBox="0 0 2400 400" preserveAspectRatio="none" aria-hidden="true">
                <path v-for="(wave, i) in HERO_WAVES" :key="i" :d="wave.d" :style="{ '--speed': `${wave.speed}s` }" />
            </svg>
            <h1 class="mk-h1">
                <span class="mk-h1-first">Tap it.</span>
                <span class="mk-h1-synth">Hear it.</span>
                <span class="mk-h1-sampler">Drop it.</span>
            </h1>
            <div class="mk-hero-demo">
                <GridDemo />
            </div>
            <div class="mk-hero-foot">
                <p class="mk-lead">
                    Synths, samples and your own voice on a step grid. Then arrange, mix and automate a whole track, right here in the browser.
                </p>
                <div class="mk-actions">
                    <RouterLink :to="{ name: 'app.index' }" class="mk-btn mk-btn--big">Start producing now</RouterLink>
                    <span class="mk-actions-hint">or press play on the grid</span>
                </div>
            </div>
        </section>

        <section class="mk-juice" aria-label="Track types">
            <div v-for="(item, index) in JUICE" :key="item.key" class="mk-band" :style="{ '--c': item.color, '--i': index }" data-reveal>
                <div class="mk-band-inner">
                    <h2 class="mk-band-title">
                        <span class="mk-band-label">{{ item.label }}</span>
                        <span class="mk-band-line">{{ item.line }}</span>
                    </h2>
                    <p class="mk-band-text">{{ item.text }}</p>
                </div>
                <div class="mk-band-row" aria-hidden="true"><i v-for="(step, i) in item.steps" :key="i" :data-on="step === 1" :style="{ '--i': i }"></i></div>
            </div>
        </section>

        <section class="mk-flow" aria-labelledby="flow-title">
            <div class="mk-flow-head">
                <p class="mk-eyebrow" data-reveal>From loop to track</p>
                <h2 id="flow-title" class="mk-h2" data-reveal>Three moves. Same order as in every studio, minus the studio.</h2>
            </div>
            <ol class="mk-flow-list">
                <li v-for="(step, index) in FLOW" :key="step.beat" class="mk-flow-step" :style="{ '--i': index }" data-reveal>
                    <span class="mk-flow-beat" aria-hidden="true">{{ step.beat }}</span>
                    <h3 class="mk-h3">{{ step.title }}</h3>
                    <p>{{ step.text }}</p>
                </li>
            </ol>
        </section>

        <section class="mk-rack" aria-labelledby="rack-title">
            <div class="mk-rack-copy" data-reveal>
                <p class="mk-eyebrow">The rack</p>
                <h2 id="rack-title" class="mk-h2">Twelve effects, stacked in any order you like.</h2>
                <p class="mk-lead mk-lead--small">
                    Each track gets its own chain, each container another, and the master a third. Drag effects around to reorder them, and automate their knobs
                    like anything else.
                </p>
            </div>
            <ul class="mk-rack-list" aria-label="Effects">
                <li
                    v-for="(effect, index) in EFFECTS"
                    :key="effect.label"
                    class="mk-module"
                    :style="{ '--i': index, '--angle': `${effect.angle}deg` }"
                    data-reveal
                >
                    <span class="mk-knob" aria-hidden="true"><i></i></span>
                    <span class="mk-module-label">{{ effect.label }}</span>
                    <span class="mk-module-led" aria-hidden="true"></span>
                </li>
            </ul>
        </section>

        <section class="mk-details" aria-labelledby="details-title">
            <div class="mk-details-head">
                <p class="mk-eyebrow" data-reveal>The small things</p>
                <h2 id="details-title" class="mk-h2" data-reveal>Built to stay out of your way.</h2>
            </div>
            <ul class="mk-details-list">
                <li v-for="(item, index) in DETAILS" :key="item.title" :style="{ '--i': index }" data-reveal>
                    <h3 class="mk-h3">{{ item.title }}</h3>
                    <p>{{ item.text }}</p>
                </li>
            </ul>
        </section>

        <section class="mk-cta" data-reveal>
            <h2 class="mk-cta-title">Your first loop<br />is a minute away.</h2>
            <div class="mk-cta-foot">
                <p class="mk-lead mk-lead--small">Add a track, tap a few steps, press play. The rest you can find out as you go.</p>
                <RouterLink :to="{ name: 'app.index' }" class="mk-btn mk-btn--big">Open the studio</RouterLink>
            </div>
            <div class="mk-wave" aria-hidden="true"><i v-for="(h, i) in WAVE" :key="i" :style="{ '--h': h, '--i': i }"></i></div>
        </section>
    </main>
</template>
