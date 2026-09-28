<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { STEP_COUNT } from '@/juicyloops/constants';
import { useContainerView } from '@/composables/useContainerView';
import { usePlayheadClass } from '@/composables/usePlayheadClass';
import { beatsOf, beatNumber } from './steps';

/**
 * The beat numbers above the grid, for as many sections as the longest track needs. Lights up under the step that is playing.
 * The play position comes from the container view (the running step; the ruler wraps it around its own length) and
 * only moves a class, so the ruler does not re-render every step.
 */
const props = defineProps<{
    sections?: number;
}>();

const { step } = useContainerView();

const length = computed(() => (props.sections ?? 1) * STEP_COUNT);
const beats = computed(() => beatsOf(length.value));

const root = useTemplateRef<HTMLElement>('root');
usePlayheadClass(root, 'ruler-cell--current', () => (step.value === null ? [] : [`[data-ruler-step="${step.value % length.value}"]`]));
</script>

<template>
    <div ref="root" class="ruler">
        <div class="ruler-spacer"></div>
        <div class="steps">
            <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
                <div v-for="(cell, i) in beat" :key="cell" class="ruler-cell" :class="{ 'ruler-cell--dot': i !== 0 }" :data-ruler-step="cell">
                    <template v-if="i === 0">{{ beatNumber(beatIndex) }}</template>
                </div>
            </div>
        </div>
    </div>
</template>
