<script setup lang="ts">
import { computed } from 'vue';

/** A small drawing of an ADSR envelope; each stage gets room in proportion to its (log-scaled) time. */
const props = defineProps<{
    attack: number;
    decay: number;
    sustain: number;
    release: number;
}>();

const WIDTH = 220;
const HEIGHT = 40;
const PAD = 3;

const span = (seconds: number, max: number) => Math.log1p(seconds * 40) / Math.log1p(max * 40);

const curve = computed(() => {
    const a = span(props.attack, 5);
    const d = span(props.decay, 5);
    const r = span(props.release, 8);
    const hold = 0.5;
    const total = a + d + hold + r;
    const x = (t: number) => PAD + (t / total) * (WIDTH - PAD * 2);
    const y = (level: number) => HEIGHT - PAD - level * (HEIGHT - PAD * 2);
    const points = [
        [x(0), y(0)],
        [x(a), y(1)],
        [x(a + d), y(props.sustain)],
        [x(a + d + hold), y(props.sustain)],
        [x(total), y(0)],
    ];
    const line = points.map(([px, py]) => `${px!.toFixed(1)},${py!.toFixed(1)}`).join(' ');
    return { line, area: `${line} ${x(total).toFixed(1)},${y(0)} ${x(0).toFixed(1)},${y(0)}` };
});
</script>

<template>
    <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" class="patch-curve" preserveAspectRatio="none" aria-hidden="true">
        <polygon :points="curve.area" fill="var(--jl-accent)" opacity="0.18" />
        <polyline :points="curve.line" fill="none" stroke="var(--jl-accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
</template>
