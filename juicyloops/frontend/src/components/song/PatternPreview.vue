<script setup lang="ts">
import type { BaseTick } from '@/juicyloops/ticks/BaseTick';

/** A thumbnail of a track's pattern: one sliver per step, lit when the step is active, as tall as its velocity. */
defineProps<{
    ticks: readonly BaseTick[];
}>();
</script>

<template>
    <div class="preview" :style="{ gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` }" aria-hidden="true">
        <span
            v-for="(tick, index) in ticks"
            :key="index"
            class="preview-step"
            :data-on="tick.isActive"
            :data-downbeat="index % 4 === 0"
            :style="tick.isActive ? { '--level': Math.max(0.25, tick.volume) } : undefined"
        ></span>
    </div>
</template>
