<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { EffectKey } from '@/juicyloops/effects/definitions';
import type { Effects } from '@/juicyloops/effects/effects';

/**
 * A small picture of what an effect does, at the top of its card: the curve of an EQ, the gain reduction of a
 * compressor or limiter, the echoes of a delay, the tail of a reverb, the speed of an LFO effect, the drive of a
 * distortion. Redrawn from the slot's values; `version` changes whenever a knob of the card moves.
 */
const props = defineProps<{
    effects: Effects;
    slotId: string;
    effect: EffectKey;
    version: number;
    on: boolean;
}>();

const W = 120;
const H = 36;

const param = (key: string): number => {
    void props.version;
    return props.effects.getParam(props.slotId, key);
};

/* ---- EQ: the three bands summed, in dB over a log frequency axis ---- */

const shelf = (f: number, corner: number, gain: number, high: boolean): number => {
    const ratio = high ? f / corner : corner / f;
    return gain / (1 + Math.pow(1 / ratio, 2));
};

const peak = (f: number, centre: number, gain: number): number => {
    const octaves = Math.log2(f / centre);
    return gain * Math.exp(-(octaves * octaves) / 2.2);
};

const eqPath = computed(() => {
    const low = param('low');
    const mid = param('mid');
    const high = param('high');
    const points: string[] = [];
    for (let i = 0; i <= 48; i++) {
        const f = 20 * Math.pow(1000, i / 48);
        const db = shelf(f, 400, low, false) + peak(f, 1000, mid) + shelf(f, 2500, high, true);
        points.push(`${((i / 48) * W).toFixed(1)},${(H / 2 - (db / 14) * (H / 2)).toFixed(1)}`);
    }
    return `M${points.join(' L')}`;
});

/* ---- delay: decaying echoes; reverb: a tail as long as its decay ---- */

const echoes = computed(() => {
    const time = param('delayTime');
    const spacing = Math.max(6, Math.min(40, time * 80));
    return Array.from({ length: 6 }, (_, index) => ({ x: 4 + index * spacing, h: H * 0.85 * Math.pow(0.6, index) })).filter((echo) => echo.x < W);
});

const tailPath = computed(() => {
    const decay = param('decay');
    const pre = param('preDelay');
    const start = 4 + Math.min(30, pre * 60);
    const length = Math.min(W - start, 12 + decay * 12);
    return `M${start},${H} L${start},${H * 0.12} Q${start + length * 0.25},${H * 0.75} ${start + length},${H} Z`;
});

/* ---- LFO effects: a wave whose count follows the rate ---- */

const wavePath = computed(() => {
    const rate = param('frequency');
    const depth = Math.min(1, param('depth') || 1);
    const cycles = Math.max(0.5, Math.min(12, Math.log2(rate + 1) * 2));
    const points: string[] = [];
    for (let i = 0; i <= 60; i++) {
        const x = (i / 60) * W;
        const y = H / 2 - Math.sin((i / 60) * cycles * Math.PI * 2) * (H / 2 - 3) * depth;
        points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return `M${points.join(' L')}`;
});

/* ---- drive: a transfer curve that bends harder with more drive ---- */

const drivePath = computed(() => {
    const amount = props.effect === 'bitCrusher' ? (16 - param('bits')) / 15 : param('distortion');
    const points: string[] = [];
    for (let i = 0; i <= 40; i++) {
        const x = i / 40;
        const input = x * 2 - 1;
        let output: number;
        if (props.effect === 'bitCrusher') {
            const levels = Math.max(2, Math.pow(2, param('bits')));
            output = Math.round(input * levels) / levels;
        } else {
            const k = 1 + amount * 12;
            output = Math.tanh(input * k) / Math.tanh(k);
        }
        points.push(`${(x * W).toFixed(1)},${(H / 2 - output * (H / 2 - 3)).toFixed(1)}`);
    }
    return `M${points.join(' L')}`;
});

/* ---- dynamics: live gain reduction ---- */

const reduction = ref(0);
let frame = 0;

const readReduction = () => {
    const node = props.effects.nodeOf(props.slotId) as { reduction?: number } | undefined;
    const value = typeof node?.reduction === 'number' ? node.reduction : 0;
    reduction.value = reduction.value * 0.6 + Math.min(0, value) * 0.4;
    frame = requestAnimationFrame(readReduction);
};

const isDynamics = computed(() => props.effect === 'compressor' || props.effect === 'limiter');

onMounted(() => {
    if (isDynamics.value) {
        frame = requestAnimationFrame(readReduction);
    }
});
onBeforeUnmount(() => cancelAnimationFrame(frame));

const threshold = computed(() => param('threshold'));
const thresholdY = computed(() => H * Math.min(1, -threshold.value / (props.effect === 'limiter' ? 50 : 100)));
</script>

<template>
    <svg class="fxvis" :data-on="props.on" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
        <line class="fxvis-axis" x1="0" :y1="H / 2" :x2="W" :y2="H / 2" />
        <path v-if="props.effect === 'equalizer'" class="fxvis-line" :d="eqPath" />
        <g v-else-if="props.effect === 'delay'">
            <rect v-for="(echo, index) in echoes" :key="index" class="fxvis-bar" :x="echo.x" :y="H - echo.h" width="4" :height="echo.h" rx="1" />
        </g>
        <path v-else-if="props.effect === 'reverb'" class="fxvis-fill" :d="tailPath" />
        <path v-else-if="['chorus', 'phaser', 'tremolo', 'vibrato', 'autoFilter'].includes(props.effect)" class="fxvis-line" :d="wavePath" />
        <path v-else-if="props.effect === 'distortion' || props.effect === 'bitCrusher'" class="fxvis-line" :d="drivePath" />
        <g v-else-if="isDynamics">
            <line class="fxvis-threshold" x1="0" :y1="thresholdY" :x2="W" :y2="thresholdY" />
            <rect class="fxvis-gr" :x="W - 22" y="2" width="16" :height="Math.min(H - 4, (-reduction / 24) * (H - 4))" rx="2" />
            <text class="fxvis-text" x="4" :y="H - 5">GR {{ reduction > -0.05 ? '0.0' : reduction.toFixed(1) }} dB</text>
        </g>
    </svg>
</template>
