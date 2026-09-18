<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { computed } from 'vue';
import StepValueLane from './StepValueLane.vue';

/** Velocity lane: how loud each step plays, drawn as one bar per step under the grid. */
const props = defineProps<{
    track: BaseTrack;
}>();

const values = computed(() => props.track.ticks.map((tick) => tick.volume));
const active = computed(() => props.track.ticks.map((tick) => tick.isActive));

const set = (index: number, value: number) => {
    const tick = props.track.ticks[index];
    if (tick) {
        tick.volume = value;
    }
};
</script>

<template>
    <div class="lane-stack">
        <StepValueLane :values="values" :active="active" @set="set" />
        <div class="lane-hint">Velocity: drag across the bars to set how loud each step plays.</div>
    </div>
</template>
