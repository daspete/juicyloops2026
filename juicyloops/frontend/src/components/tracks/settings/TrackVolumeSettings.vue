<script setup lang="ts">
import { setStepVelocity, stepCells, stepVelocity } from '@/juicyloops/notes/stepView';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { computed } from 'vue';
import StepValueLane from './StepValueLane.vue';

/**
 * Velocity lane: how loud each step plays, drawn as one bar per step under the grid. A step's bar is the velocity of
 * the notes starting in it; an empty step shows the full velocity a note switched on there gets.
 */
const props = defineProps<{
    track: BaseTrack;
}>();

const cells = computed(() => stepCells(props.track.notes, props.track.length));
const values = computed(() => cells.value.map((notes) => (notes.length ? stepVelocity(notes) : 1)));
const active = computed(() => cells.value.map((notes) => notes.length > 0));

const set = (index: number, value: number) => setStepVelocity(props.track, index, value);
</script>

<template>
    <div class="lane-stack">
        <StepValueLane :values="values" :active="active" @set="set" />
        <div class="lane-hint">Velocity: drag across the bars to set how loud each step plays.</div>
    </div>
</template>
