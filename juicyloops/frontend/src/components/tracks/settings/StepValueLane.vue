<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { beatsOf } from '../steps';

/**
 * A lane of bars under the step grid, one per step, aligned with the pads above.
 * Press and drag across it to draw a value (0..1) for every step. Velocity and automation both draw with it.
 */
const props = defineProps<{
    /** One value per step, 0..1. */
    values: readonly number[];
    /** Which steps hold a note, so their bars can be told apart from silent ones. Every step counts when omitted. */
    active?: readonly boolean[];
    /** Reads a value for the tooltip of a bar. */
    format?: (value: number, index: number) => string;
}>();

const emit = defineEmits<{
    set: [index: number, value: number];
}>();

const beats = computed(() => beatsOf(props.values.length));

const isDrawing = ref(false);

const applyAt = (event: PointerEvent) => {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-step]');
    if (!cell) {
        return;
    }

    const rect = cell.getBoundingClientRect();
    const ratio = 1 - (event.clientY - rect.top) / rect.height;
    emit('set', Number(cell.dataset.step), Math.round(Math.min(1, Math.max(0, ratio)) * 100) / 100);
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

const title = (index: number) => (props.format ? props.format(props.values[index]!, index) : `Step ${index + 1}: ${Math.round(props.values[index]! * 100)}%`);

onMounted(() => window.addEventListener('pointerup', stopDrawing));
onBeforeUnmount(() => window.removeEventListener('pointerup', stopDrawing));
</script>

<template>
    <div class="steps" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointercancel="stopDrawing">
        <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
            <div
                v-for="index in beat"
                :key="index"
                class="barlane-cell"
                :class="{ 'barlane-cell--active': props.active ? props.active[index] : true }"
                :data-step="index"
                :title="title(index)"
            >
                <div class="barlane-fill" :style="{ height: `${props.values[index]! * 100}%` }"></div>
            </div>
        </div>
    </div>
</template>
