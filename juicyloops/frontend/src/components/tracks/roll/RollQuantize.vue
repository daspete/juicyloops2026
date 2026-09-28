<script setup lang="ts">
import { GRIDS, type GridId, type QuantizeOptions } from '@/juicyloops/notes/grid';
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';

/**
 * The quantize popover of the piano roll: which grid, how strongly, and whether ends move too. The options are a
 * model (the roll keeps them for the next time); applying them is up to the roll.
 */
const props = defineProps<{
    /** How many notes it will touch: the selection, or every note. */
    count: number;
    hasSelection: boolean;
}>();

const options = defineModel<QuantizeOptions>('options', { required: true });

const emit = defineEmits<{
    apply: [];
    close: [];
}>();

const QUANTIZE_GRIDS = GRIDS.filter((grid) => grid.id !== 'off');

const panel = useTemplateRef<HTMLElement>('panel');

/* A press anywhere outside closes it, like a menu; the toggle button closes it itself. */
const onOutside = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null;
    if (panel.value && target && !panel.value.contains(target) && !target.closest('[data-quantize-toggle]')) {
        emit('close');
    }
};

onMounted(() => window.addEventListener('pointerdown', onOutside, true));
onBeforeUnmount(() => window.removeEventListener('pointerdown', onOutside, true));

const setGrid = (event: Event) => {
    options.value = { ...options.value, grid: (event.target as HTMLSelectElement).value as GridId };
};

const setStrength = (event: Event) => {
    options.value = { ...options.value, strength: Number((event.target as HTMLInputElement).value) / 100 };
};

const setEnds = (event: Event) => {
    options.value = { ...options.value, ends: (event.target as HTMLInputElement).checked };
};
</script>

<template>
    <div ref="panel" class="proll-pop" role="dialog" aria-label="Quantize" @keydown.esc.stop="emit('close')">
        <label class="proll-pop-row">
            <span class="proll-pop-label">Grid</span>
            <select class="select select--tight" :value="options.grid" @change="setGrid">
                <option v-for="grid in QUANTIZE_GRIDS" :key="grid.id" :value="grid.id">{{ grid.label }}</option>
            </select>
        </label>
        <label class="proll-pop-row">
            <span class="proll-pop-label">Strength</span>
            <input
                class="proll-range"
                type="range"
                min="0"
                max="100"
                step="5"
                :value="Math.round(options.strength * 100)"
                aria-label="Strength"
                @input="setStrength"
            />
            <span class="proll-pop-value">{{ Math.round(options.strength * 100) }} %</span>
        </label>
        <label class="proll-pop-row proll-pop-check">
            <input type="checkbox" :checked="options.ends" @change="setEnds" />
            <span>Quantize note ends too</span>
        </label>
        <div class="proll-pop-foot">
            <span class="lane-hint">{{ props.hasSelection ? `${props.count} selected ${props.count === 1 ? 'note' : 'notes'}` : `All ${props.count} notes` }}</span>
            <button type="button" class="chip chip--juice" :disabled="!props.count" @click="emit('apply')">Quantize</button>
        </div>
    </div>
</template>
