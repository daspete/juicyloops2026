<script setup lang="ts">
import type { PatternNote } from '@/juicyloops/notes/Note';
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import type { TrackPlayhead } from '@/composables/useContainerView';
import { usePlayheadClass } from '@/composables/usePlayheadClass';
import { STEP_COUNT } from '@/juicyloops/constants';
import { beatsOf } from './steps';

/**
 * One row of step cells, grouped by beat: the step grid, a view onto a pattern's notes. A cell is lit when a note
 * starts in it (see `notes/stepView.ts`).
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
    /** Per step of the pattern, the notes starting in it (`stepCells`); its length is the pattern's. */
    cells: readonly (readonly PatternNote[])[];
    /**
     * Where the playhead is: inside this pattern (0 .. cells.length - 1), and inside the section (0 .. STEP_COUNT - 1)
     * so the ghost repeats know which one is sounding. -1 while silent.
     */
    playhead: TrackPlayhead;
    spans?: ReadonlyMap<number, StepSpan>;
}>();

const emit = defineEmits<{
    /** The user wants this step's cell to become lit (`active`) or empty. */
    paint: [index: number, active: boolean];
}>();

defineSlots<{
    default?: (props: { notes: readonly PatternNote[]; index: number }) => unknown;
}>();

const isLit = (index: number): boolean => (props.cells[index]?.length ?? 0) > 0;

const beats = computed(() => beatsOf(props.cells.length));

/*
 * A pattern that divides the section repeats until the section is full. The repeats are drawn as ghosts,
 * so what you see across the row is what you hear across the ruler above. Lengths that do not divide
 * the section (12, 24) drift against it, so they get no ghosts.
 */
const ghostBeats = computed(() =>
    props.cells.length < STEP_COUNT && STEP_COUNT % props.cells.length === 0
        ? beatsOf(STEP_COUNT - props.cells.length).map((beat) => beat.map((index) => index + props.cells.length))
        : [],
);

/* The playhead lights its cell without re-rendering the row (see `usePlayheadClass`). */
const root = useTemplateRef<HTMLElement>('root');
usePlayheadClass(root, 'tick--current', () => {
    const tick = props.playhead.currentTick.value;
    const section = props.playhead.sectionStep.value;
    return [...(tick >= 0 ? [`[data-step="${tick}"]`] : []), ...(section >= 0 ? [`[data-ghost-step="${section}"]`] : [])];
});

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

    painting.value = !isLit(index);
    emit('paint', index, painting.value);
};

const onPointerMove = (event: PointerEvent) => {
    if (painting.value === null) {
        return;
    }

    const index = stepAt(event);
    if (index === null) {
        return;
    }

    if (isLit(index) !== painting.value) {
        emit('paint', index, painting.value);
    }
};

const stopPainting = () => (painting.value = null);

/** Keyboard activation arrives as a click with `detail === 0`; pointer clicks were already handled on pointerdown. */
const onClick = (event: MouseEvent, index: number) => {
    if (event.detail === 0) {
        emit('paint', index, !isLit(index));
    }
};

onMounted(() => window.addEventListener('pointerup', stopPainting));
onBeforeUnmount(() => window.removeEventListener('pointerup', stopPainting));
</script>

<template>
    <div ref="root" class="steps track-steps" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointercancel="stopPainting">
        <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
            <button
                v-for="index in beat"
                :key="index"
                type="button"
                class="tick"
                :class="{
                    'tick--downbeat': index % 4 === 0,
                    'tick--active': isLit(index),
                    'tick--tail': !isLit(index) && spans?.get(index)?.tail,
                    'tick--open-end': spans?.get(index)?.openEnd,
                    'tick--partial': isLit(index) && (spans?.get(index)?.fill ?? 1) < 1,
                }"
                :style="(spans?.get(index)?.fill ?? 1) < 1 ? { '--fill': spans!.get(index)!.fill } : undefined"
                :data-step="index"
                :aria-label="`Step ${index + 1}`"
                :aria-pressed="isLit(index)"
                @click="onClick($event, index)"
            >
                <slot :notes="cells[index]!" :index="index" />
            </button>
        </div>
        <div v-for="(beat, beatIndex) in ghostBeats" :key="`ghost-${beatIndex}`" class="beat" aria-hidden="true">
            <div
                v-for="index in beat"
                :key="index"
                class="tick tick--ghost"
                :class="{
                    'tick--downbeat': index % 4 === 0,
                    'tick--active': isLit(index % cells.length),
                }"
                :data-ghost-step="index"
            ></div>
        </div>
    </div>
</template>
