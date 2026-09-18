<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { beatsOf } from '../steps';

/**
 * Velocity lane: one bar per step, aligned with the grid above.
 * Press and drag to draw how loud each step plays.
 */
const props = defineProps<{
    track: BaseTrack;
}>();

const beats = computed(() => beatsOf(props.track.length));

const isDrawing = ref(false);

const applyAt = (event: PointerEvent) => {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-step]');
    if (!cell) {
        return;
    }

    const rect = cell.getBoundingClientRect();
    const ratio = 1 - (event.clientY - rect.top) / rect.height;
    const tick = props.track.ticks[Number(cell.dataset.step)];
    if (tick) {
        tick.volume = Math.round(Math.min(1, Math.max(0, ratio)) * 100) / 100;
    }
};

const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
        return;
    }
    isDrawing.value = true;
    applyAt(event);
};

const onPointerMove = (event: PointerEvent) => {
    if (isDrawing.value) {
        applyAt(event);
    }
};

const stopDrawing = () => (isDrawing.value = false);

onMounted(() => window.addEventListener('pointerup', stopDrawing));
onBeforeUnmount(() => window.removeEventListener('pointerup', stopDrawing));
</script>

<template>
    <div class="flex flex-col gap-1">
        <div class="steps" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointercancel="stopDrawing">
            <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
                <div
                    v-for="index in beat"
                    :key="index"
                    class="velocity-cell"
                    :class="{ 'velocity-cell--active': track.ticks[index]!.isActive }"
                    :data-step="index"
                    :title="`Step ${index + 1}: ${Math.round(track.ticks[index]!.volume * 100)}%`"
                >
                    <div class="velocity-bar" :style="{ height: `${track.ticks[index]!.volume * 100}%` }"></div>
                </div>
            </div>
        </div>
        <div class="text-xs text-(--jl-muted) px-0.5">Velocity: drag across the bars to set how loud each step plays.</div>
    </div>
</template>
