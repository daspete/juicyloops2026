<script setup lang="ts">
/** The marketing page. Prerendered at build time; the grid in the hero plays once the page is hydrated. */
import { RouterLink } from 'vue-router';
import GridDemo from '@/components/marketing/GridDemo.vue';
import HeroWave from '@/components/marketing/HeroWave.vue';

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

/* The three moves as clips on a song timeline, each in its own colour with a small picture of what it does. */
const FLOW = [
    {
        beat: '1',
        title: 'Loop',
        color: 'var(--jl-synth)',
        visual: 'grid',
        text: 'Tap steps on a one-bar grid. Give a track its own length to make polyrhythms, and the ghost steps show you where it repeats.',
    },
    {
        beat: '2',
        title: 'Arrange',
        color: 'var(--jl-brand)',
        visual: 'clips',
        text: 'Group tracks into containers, then drag them onto the song timeline as clips. Move them, stretch them, cut them in half.',
    },
    {
        beat: '3',
        title: 'Mix and automate',
        color: 'var(--jl-mic)',
        visual: 'curve',
        text: 'Effects on each track, on each group, and on the master. Any knob can ride a curve, per step inside a loop or across the whole song.',
    },
];

/* Pictures inside the flow clips: a tiny grid, a few clips on lanes, and an automation curve. All fixed. */
const FLOW_GRID = [
    [1, 0, 0, 1, 0, 0, 1, 0],
    [0, 0, 1, 0, 0, 0, 1, 0],
    [0, 1, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 0, 1, 0, 1, 0],
];
const FLOW_CLIPS = [
    [
        { start: 0, span: 3 },
        { start: 4, span: 2 },
        { start: 6, span: 2 },
    ],
    [
        { start: 1, span: 2 },
        { start: 3, span: 4 },
    ],
    [
        { start: 0, span: 2 },
        { start: 5, span: 3 },
    ],
];
const FLOW_CURVE = 'M0,70 C30,70 40,20 70,20 S110,60 140,60 S180,10 210,10 S250,50 280,50';

/* The rack shows each effect as a module with one knob; the knob angles are fixed so both sides draw the same. */
const JUICE_CYCLE = ['var(--jl-synth)', 'var(--jl-sampler)', 'var(--jl-mic)', 'var(--jl-brand)'];
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
].map((effect, index) => ({ ...effect, color: JUICE_CYCLE[index % JUICE_CYCLE.length] }));

/* Bar heights of the waveform under the closing section, in percent; fixed so the server and the browser draw the same. */
const WAVE = [
    37, 46, 61, 60, 65, 56, 40, 33, 20, 24, 28, 42, 62, 81, 78, 76, 70, 58, 39, 26, 30, 22, 39, 40, 44, 45, 44, 45, 30, 30, 27, 23, 25, 19, 19, 21, 26, 23, 22,
    26, 25, 23, 28, 26, 22, 30, 37, 49, 55, 54, 61, 44, 38, 33, 20, 26, 30, 53, 70, 80, 74, 60, 48, 35, 28, 33, 41, 52, 66, 72, 58, 44, 31, 24, 29, 38, 47, 56,
    63, 51,
];

/* Six pads, like a drum pad bank: each with a colour and a short key label. */
const DETAILS = [
    { key: 'Q/P', title: 'Quick or Pro', text: 'Start with just the grid. Switch to Pro for the arranger, mixer and automation whenever you feel like it.' },
    { key: 'Ctrl+Z', title: 'Undo everything', text: 'Every tap, drag and knob turn is one step back. Ctrl+Z as deep as you like, Ctrl+Y forward again.' },
    {
        key: 'Ctrl+S',
        title: 'One file, all of it',
        text: 'Save the session to your disk as a single file: tracks, samples, recordings, automation. Open it on any machine.',
    },
    { key: '0 MB', title: 'Nothing to install', text: 'No account, no download, no plugins. It runs in the browser you already have, on a phone too.' },
    { key: '☾ / ☀', title: 'Light or dark', text: 'Follows your system, or flip it yourself. The colours of the tracks stay the same either way.' },
    { key: 'Space', title: 'Keyboard first', text: 'Space plays and stops, Ctrl+S saves, Ctrl+O opens. Hold a button to repeat it, the app keeps up.' },
].map((item, index) => ({ ...item, color: JUICE_CYCLE[index % JUICE_CYCLE.length] }));
</script>

<template>
    <main class="mk-home">
        <section class="mk-hero">
            <HeroWave />
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
            <div class="mk-timeline" aria-hidden="true">
                <span v-for="bar in 12" :key="bar" :data-major="bar % 4 === 1">{{ bar }}</span>
                <i class="mk-timeline-head"></i>
            </div>
            <ol class="mk-flow-list">
                <li v-for="(step, index) in FLOW" :key="step.beat" class="mk-clip" :style="{ '--c': step.color, '--i': index }" data-reveal>
                    <div class="mk-clip-bar">
                        <span class="mk-clip-beat">{{ step.beat }}</span>
                        <span class="mk-clip-name">Bars {{ index * 4 + 1 }}–{{ index * 4 + 4 }}</span>
                    </div>
                    <div class="mk-clip-body">
                        <div class="mk-clip-visual" aria-hidden="true">
                            <div v-if="step.visual === 'grid'" class="mk-mini-grid">
                                <i v-for="(cell, i) in FLOW_GRID.flat()" :key="i" :data-on="cell === 1" :style="{ '--i': i % 8 }"></i>
                            </div>
                            <div v-else-if="step.visual === 'clips'" class="mk-mini-lanes">
                                <div v-for="(lane, l) in FLOW_CLIPS" :key="l" class="mk-mini-lane">
                                    <i v-for="(clip, c) in lane" :key="c" :style="{ '--start': clip.start, '--span': clip.span }"></i>
                                </div>
                            </div>
                            <svg v-else class="mk-mini-curve" viewBox="0 0 280 80" preserveAspectRatio="none">
                                <path :d="FLOW_CURVE" />
                                <circle v-for="(x, i) in [0, 70, 140, 210, 280]" :key="i" :cx="x" :cy="[70, 20, 60, 10, 50][i]" r="4" />
                            </svg>
                        </div>
                        <h3 class="mk-h3">{{ step.title }}</h3>
                        <p>{{ step.text }}</p>
                    </div>
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
                    :style="{ '--i': index, '--c': effect.color, '--angle': `${effect.angle}deg` }"
                    data-reveal
                >
                    <span class="mk-module-jack" aria-hidden="true"></span>
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
            <ul class="mk-pads">
                <li v-for="(item, index) in DETAILS" :key="item.title" class="mk-pad" :style="{ '--i': index, '--c': item.color }" data-reveal>
                    <span class="mk-pad-key">{{ item.key }}</span>
                    <h3 class="mk-h3">{{ item.title }}</h3>
                    <p>{{ item.text }}</p>
                </li>
            </ul>
        </section>

        <section class="mk-cta" data-reveal>
            <h2 class="mk-cta-title">Your first loop<br />is a minute away.</h2>
            <div class="mk-cta-foot">
                <p class="mk-cta-text">Add a track, tap a few steps, press play. The rest you can find out as you go.</p>
                <RouterLink :to="{ name: 'app.index' }" class="mk-btn mk-btn--big mk-btn--ink">Open the studio</RouterLink>
            </div>
            <div class="mk-wave" aria-hidden="true"><i v-for="(h, i) in WAVE" :key="i" :style="{ '--h': h, '--i': i }"></i></div>
        </section>
    </main>
</template>
