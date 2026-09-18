<script setup lang="ts">
import { NOTE_LENGTHS, noteLengthIndex } from '@/juicyloops/notes';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { BEATS } from '../steps';

/**
 * Length lane: one cell per step showing how long its note rings, aligned with the grid above.
 * Press and drag up or down to pick one of the available lengths.
 */
const props = defineProps<{
    track: SynthTrack;
}>();

const isDrawing = ref(false);

const applyAt = (event: PointerEvent) => {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-step]');
    if (!cell) {
        return;
    }

    const rect = cell.getBoundingClientRect();
    const ratio = 1 - (event.clientY - rect.top) / rect.height;
    const index = Math.min(NOTE_LENGTHS.length - 1, Math.max(0, Math.floor(ratio * NOTE_LENGTHS.length)));
    const tick = props.track.ticks[Number(cell.dataset.step)];
    if (tick) {
        tick.duration = NOTE_LENGTHS[index]!.tone;
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

const level = (step: number) => (noteLengthIndex(props.track.ticks[step]!.duration) + 1) / NOTE_LENGTHS.length;
const label = (step: number) => NOTE_LENGTHS[noteLengthIndex(props.track.ticks[step]!.duration)]?.label ?? '';

onMounted(() => window.addEventListener('pointerup', stopDrawing));
onBeforeUnmount(() => window.removeEventListener('pointerup', stopDrawing));
</script>

<template>
    <div class="flex flex-col gap-1">
        <div class="steps" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointercancel="stopDrawing">
            <div v-for="(beat, beatIndex) in BEATS" :key="beatIndex" class="beat">
                <div
                    v-for="index in beat"
                    :key="index"
                    class="velocity-cell length-cell"
                    :class="{ 'velocity-cell--active': track.ticks[index]!.isActive }"
                    :data-step="index"
                    :title="`Step ${index + 1}: ${label(index)} ${label(index) === '1' ? 'step' : 'steps'}`"
                >
                    <div class="velocity-bar" :style="{ height: `${level(index) * 100}%` }"></div>
                    <span class="length-label">{{ label(index) }}</span>
                </div>
            </div>
        </div>
        <div class="text-xs text-(--jl-muted) px-0.5">Length: drag up or down to set how many steps each note rings for.</div>
    </div>
</template>
