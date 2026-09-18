<script setup lang="ts">
import { computed } from 'vue';
import { STEP_COUNT } from '@/juicyloops/constants';
import { beatsOf, beatNumber } from './steps';

/** The beat numbers above the grid, for as many sections as the longest track needs. Lights up under the step that is playing. */
const props = defineProps<{
    /** The running play position; the ruler wraps it around its own length. */
    currentStep: number;
    sections?: number;
}>();

const length = computed(() => (props.sections ?? 1) * STEP_COUNT);
const beats = computed(() => beatsOf(length.value));
const current = computed(() => props.currentStep % length.value);
</script>

<template>
    <div class="ruler">
        <div class="ruler-spacer"></div>
        <div class="steps">
            <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
                <div
                    v-for="(step, i) in beat"
                    :key="step"
                    class="ruler-cell"
                    :class="{ 'ruler-cell--dot': i !== 0, 'ruler-cell--current': current === step }"
                >
                    <template v-if="i === 0">{{ beatNumber(beatIndex) }}</template>
                </div>
            </div>
        </div>
    </div>
</template>
