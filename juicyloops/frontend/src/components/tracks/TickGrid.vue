<script setup lang="ts" generic="T extends BaseTick">
import type { BaseTick } from '@/juicyloops/ticks/BaseTick';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { STEP_COUNT } from '@/juicyloops/constants';
import { beatsOf } from './steps';

/**
 * One row of step cells, grouped by beat.
 * Press a cell to flip it, keep the pointer down and sweep across to paint the same state onto its neighbours.
 * The optional default slot renders the cell content.
 */
/** Extra decoration for a cell: covered by a longer note (`tail`), joined to the next cell (`openEnd`), or partially filled. */
export interface StepSpan {
    tail?: boolean;
    openEnd?: boolean;
    fill?: number;
}

const props = defineProps<{
    ticks: T[];
    /** The playhead inside this pattern (0 .. ticks.length - 1). */
    currentTick: number;
    /** The playhead inside the section (0 .. STEP_COUNT - 1), so the ghost repeats know which one is sounding. */
    sectionStep?: number;
    spans?: ReadonlyMap<number, StepSpan>;
}>();

const emit = defineEmits<{
    /** The user wants this tick to become `active`. */
    paint: [tick: T, index: number, active: boolean];
}>();

defineSlots<{
    default?: (props: { tick: T; index: number }) => unknown;
}>();

const beats = computed(() => beatsOf(props.ticks.length));

/*
 * A pattern that divides the section repeats until the section is full. The repeats are drawn as ghosts,
 * so what you see across the row is what you hear across the ruler above. Lengths that do not divide
 * the section (12, 24) drift against it, so they get no ghosts.
 */
const ghostBeats = computed(() =>
    props.ticks.length < STEP_COUNT && STEP_COUNT % props.ticks.length === 0
        ? beatsOf(STEP_COUNT - props.ticks.length).map((beat) => beat.map((index) => index + props.ticks.length))
        : [],
);

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
    <div class="steps track-steps" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointercancel="stopPainting">
        <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
            <button
                v-for="index in beat"
                :key="index"
                type="button"
                class="tick"
                :class="{
                    'tick--downbeat': index % 4 === 0,
                    'tick--active': ticks[index]!.isActive,
                    'tick--tail': !ticks[index]!.isActive && spans?.get(index)?.tail,
                    'tick--open-end': spans?.get(index)?.openEnd,
                    'tick--partial': ticks[index]!.isActive && (spans?.get(index)?.fill ?? 1) < 1,
                    'tick--current': currentTick === index,
                }"
                :style="(spans?.get(index)?.fill ?? 1) < 1 ? { '--fill': spans!.get(index)!.fill } : undefined"
                :data-step="index"
                :aria-label="`Step ${index + 1}`"
                :aria-pressed="ticks[index]!.isActive"
                @click="onClick($event, index)"
            >
                <slot :tick="ticks[index]!" :index="index" />
            </button>
        </div>
        <div v-for="(beat, beatIndex) in ghostBeats" :key="`ghost-${beatIndex}`" class="beat" aria-hidden="true">
            <div
                v-for="index in beat"
                :key="index"
                class="tick tick--ghost"
                :class="{
                    'tick--downbeat': index % 4 === 0,
                    'tick--active': ticks[index % ticks.length]!.isActive,
                    'tick--current': sectionStep === index,
                }"
            ></div>
        </div>
    </div>
</template>
