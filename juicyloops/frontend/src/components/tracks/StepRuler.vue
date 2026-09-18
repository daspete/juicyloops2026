<script setup lang="ts">
import { BEATS, beatNumber } from './steps';

/** The beat numbers above the grid. Lights up under the step that is playing. */
defineProps<{
    currentTick: number;
}>();
</script>

<template>
    <div class="flex gap-3 px-2">
        <div class="shrink-0" style="width: var(--jl-track-head)"></div>
        <div class="steps flex-1 min-w-0">
            <div v-for="(beat, beatIndex) in BEATS" :key="beatIndex" class="beat">
                <div
                    v-for="(step, i) in beat"
                    :key="step"
                    class="ruler-cell"
                    :class="{ 'ruler-cell--dot': i !== 0, 'ruler-cell--current': currentTick === step }"
                >
                    <template v-if="i === 0">{{ beatNumber(beatIndex) }}</template>
                </div>
            </div>
        </div>
    </div>
</template>
