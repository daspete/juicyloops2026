<script setup lang="ts">
import { computed } from 'vue';
import { STEP_COUNT } from '@/juicyloops/constants';
import { useContainerView } from '@/composables/useContainerView';
import { BEAT_SIZE } from './steps';

/**
 * The playhead beam through every track row: where the ruler's current step sits, in the same units the grids are laid
 * out in. Its own component, so the step moving every tick re-renders this one element and not the rows around it.
 */
const props = defineProps<{
    /** How many sections the ruler spans; the beam wraps the running step around them like the ruler does. */
    sections: number;
}>();

const { step } = useContainerView();

const beamStyle = computed(() => {
    const at = (step.value ?? 0) % (props.sections * STEP_COUNT);
    const beat = Math.floor(at / BEAT_SIZE);
    const cell = at % BEAT_SIZE;
    return { left: `calc(var(--jl-head-space) + ${beat} * (var(--jl-beat-w) + var(--jl-beat-gap)) + ${cell} * (var(--jl-cell-w) + var(--jl-cell-gap)))` };
});
</script>

<template>
    <div v-if="step !== null" class="beam" :style="beamStyle" aria-hidden="true"></div>
</template>
