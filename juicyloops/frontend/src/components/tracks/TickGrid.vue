<script setup lang="ts" generic="T extends BaseTick">
import type { BaseTick } from '@/juicyloops/ticks/BaseTick';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { BEATS } from './steps';

/**
 * One row of step cells, grouped by beat.
 * Press a cell to flip it, keep the pointer down and sweep across to paint the same state onto its neighbours.
 * The optional default slot renders the cell content.
 */
const props = defineProps<{
    ticks: T[];
    currentTick: number;
}>();

const emit = defineEmits<{
    /** The user wants this tick to become `active`. */
    paint: [tick: T, index: number, active: boolean];
}>();

defineSlots<{
    default?: (props: { tick: T; index: number }) => unknown;
}>();

/** The state we are painting while the pointer is down, null when idle. */
const painting = ref<boolean | null>(null);

const stepAt = (event: PointerEvent): number | null => {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-step]');
    return cell ? Number(cell.dataset.step) : null;
};

const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
        return;
    }

    const index = stepAt(event);
    if (index === null) {
        return;
    }

    const tick = props.ticks[index]!;
    painting.value = !tick.isActive;
    emit('paint', tick, index, painting.value);
};

const onPointerMove = (event: PointerEvent) => {
    if (painting.value === null) {
        return;
    }

    const index = stepAt(event);
    if (index === null) {
        return;
    }

    const tick = props.ticks[index]!;
    if (tick.isActive !== painting.value) {
        emit('paint', tick, index, painting.value);
    }
};

const stopPainting = () => (painting.value = null);

/** Keyboard activation arrives as a click with `detail === 0`; pointer clicks were already handled on pointerdown. */
const onClick = (event: MouseEvent, index: number) => {
    if (event.detail === 0) {
        const tick = props.ticks[index]!;
        emit('paint', tick, index, !tick.isActive);
    }
};

onMounted(() => window.addEventListener('pointerup', stopPainting));
onBeforeUnmount(() => window.removeEventListener('pointerup', stopPainting));
</script>

<template>
    <div class="steps h-15" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointercancel="stopPainting">
        <div v-for="(beat, beatIndex) in BEATS" :key="beatIndex" class="beat">
            <button
                v-for="index in beat"
                :key="index"
                type="button"
                class="tick"
                :class="{
                    'tick--downbeat': index % 4 === 0,
                    'tick--active': ticks[index]!.isActive,
                    'tick--current': currentTick === index,
                }"
                :data-step="index"
                :aria-label="`Step ${index + 1}`"
                :aria-pressed="ticks[index]!.isActive"
                @click="onClick($event, index)"
            >
                <slot :tick="ticks[index]!" :index="index" />
            </button>
        </div>
    </div>
</template>
