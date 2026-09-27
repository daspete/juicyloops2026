<script setup lang="ts" generic="T extends NoteTick">
import { VirtualScroller } from 'primevue';
import { computed, nextTick, onBeforeUnmount, reactive, ref, useTemplateRef, watch } from 'vue';
import FloatingWindow from '../ui/FloatingWindow.vue';
import { centredWindow, isOnTop, nextZ, type FloatingWindowState } from '../ui/floatingWindow';
import { cellUnder, noteEnd, tickSteps, useNoteResize, type NoteTick } from './noteDrag';
import { beatNumber, beatsOf } from './steps';

/** One row of the roll: the note its steps get, and what its key says. */
export interface RollRow {
    note: string;
    label: string;
    /** Drawn as a black key. */
    black?: boolean;
    /** A landmark row (every C, the root of a sample), drawn with a stronger key. */
    marked?: boolean;
}

/**
 * The piano roll window, floating over the whole screen like the container windows float over the song: move it by
 * its title bar, resize it by its edges, keep playing and editing the tracks while it is open.
 *
 * One row per note, one column per step. Click a cell to place the step's note there,
 * drag a note to move it, drag its ends to change its length (when the ticks have lengths).
 * Every step holds one note, so placing a note on a step moves whatever that step played before.
 */
const props = defineProps<{
    ticks: T[];
    rows: readonly RollRow[];
    /** The playhead inside the pattern, -1 while stopped. */
    currentTick: number;
    header: string;
    accent: string;
    /** Which row a tick shows on; its note unless the track maps notes onto fewer rows. */
    rowOf?: (tick: T) => string;
    /** Notes can be stretched by their ends. Only for ticks with a length. */
    resizable?: boolean;
    /** The row to show when the pattern is empty. */
    home?: string;
    hint?: string;
}>();

const visible = defineModel<boolean>('visible', { required: true });

defineSlots<{
    /** Extra buttons in the footer, before the hint. */
    foot?: () => unknown;
}>();

/* ---- the window ---- */

const DEFAULT_WIDTH = 1150;
const DEFAULT_HEIGHT = 640;

/** The screen, which the window floats over. */
const viewport = reactive({ width: window.innerWidth, height: window.innerHeight });
const onResize = () => {
    viewport.width = window.innerWidth;
    viewport.height = window.innerHeight;
};

/** Made the first time the roll opens, then kept, so it opens again where it was left. */
const frame = ref<FloatingWindowState | null>(null);

const bringToFront = () => {
    if (frame.value && !isOnTop(frame.value)) {
        frame.value.z = nextZ();
    }
};

watch(
    visible,
    async (open) => {
        if (open) {
            window.addEventListener('resize', onResize);
            onResize();
            if (frame.value) {
                bringToFront();
            } else {
                frame.value = centredWindow(viewport, DEFAULT_WIDTH, DEFAULT_HEIGHT);
                // On a phone there is no room to float: the roll fills the screen.
                frame.value.isMaximized = viewport.width < 640;
            }
            await nextTick();
            await scrollToPattern();
        } else {
            window.removeEventListener('resize', onResize);
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => window.removeEventListener('resize', onResize));

const isMaximized = computed(() => frame.value?.isMaximized ?? false);

/* Row height of the roll. The virtual scroller needs the number, the CSS reads the same value. Taller when the roll has the whole screen. */
const ROW_HEIGHT = 28;
const ROW_HEIGHT_MAX = 36;
const rowHeight = computed(() => (isMaximized.value ? ROW_HEIGHT_MAX : ROW_HEIGHT));

const beats = computed(() => beatsOf(props.ticks.length));

const rowKey = (tick: T): string => (props.rowOf ? props.rowOf(tick) : tick.note);

/** One note bar in a row: where it starts, how many cells it covers, and how much of a cell a short note fills. */
interface RollNote {
    head: number;
    end: number;
    fill: number;
}

const rowNotes = (note: string): RollNote[] =>
    props.ticks.flatMap((tick, index) => {
        if (!tick.isActive || rowKey(tick) !== note) {
            return [];
        }
        const steps = tickSteps(tick);
        return [{ head: index, end: noteEnd(props.ticks.length, index, steps), fill: Math.min(1, steps) }];
    });

/* Where a cell sits inside the row, in the same units the grid is laid out in, so note bars line up with the cells under them. */
const cellLeft = (step: number) => `${Math.floor(step / 4)} * (var(--jl-beat-w) + var(--jl-beat-gap)) + ${step % 4} * (var(--jl-cell-w) + 3px)`;

const noteStyle = (note: RollNote) => ({
    left: `calc(${cellLeft(note.head)})`,
    width: note.fill < 1 ? `calc(var(--jl-cell-w) * ${note.fill})` : `calc(${cellLeft(note.end)} - (${cellLeft(note.head)}) + var(--jl-cell-w))`,
});

const { startResize } = useNoteResize(() => props.ticks);

/* ---- moving notes around ---- */

type Move = { head: number; grab: number; moved: boolean };
let move: Move | null = null;

/** Puts the note at `head` onto another step and row. The target step must be free (or the note's own). */
const relocate = (head: number, step: number, note: string): number => {
    const ticks = props.ticks;
    const source = ticks[head]!;
    const target = Math.max(0, Math.min(ticks.length - 1, step));
    if (target !== head && ticks[target]!.isActive) {
        return head;
    }
    if (target !== head) {
        const destination = ticks[target]!;
        if (source.duration) {
            destination.duration = source.duration;
        }
        destination.volume = source.volume;
        destination.isActive = true;
        source.isActive = false;
    }
    ticks[target]!.note = note;
    return target;
};

const onMoveMove = (event: PointerEvent) => {
    if (!move) {
        return;
    }
    const cell = cellUnder(event.clientX, event.clientY);
    const row = cell?.closest<HTMLElement>('[data-note]');
    if (!cell || !row) {
        return;
    }
    const step = Number(cell.dataset.step) - move.grab;
    const note = row.dataset.note!;
    if (step === move.head && note === rowKey(props.ticks[move.head]!)) {
        return;
    }
    move.moved = true;
    move.head = relocate(move.head, step, note);
};

const stopMove = () => {
    if (move && !move.moved) {
        // A plain click on a note switches it off, like clicking its cell.
        props.ticks[move.head]!.isActive = false;
    }
    move = null;
    window.removeEventListener('pointermove', onMoveMove);
    window.removeEventListener('pointerup', stopMove);
};

const startMove = (event: PointerEvent, head: number) => {
    if (event.button !== 0) {
        return;
    }
    const cell = cellUnder(event.clientX, event.clientY);
    move = { head, grab: cell ? Number(cell.dataset.step) - head : 0, moved: false };
    window.addEventListener('pointermove', onMoveMove);
    window.addEventListener('pointerup', stopMove);
};

onBeforeUnmount(stopMove);

/** Clicking a tick's own row toggles it, clicking another row moves the tick there and activates it. */
const placeNote = (tick: T, note: string) => {
    if (rowKey(tick) === note) {
        tick.isActive = !tick.isActive;
        return;
    }

    tick.isActive = true;
    tick.note = note;
};

const scroller = useTemplateRef<InstanceType<typeof VirtualScroller>>('scroller');

/** Scrolls the roll so the pattern's notes are in view (or the home row when nothing is set yet). */
const scrollToPattern = async () => {
    await nextTick();

    const activeTick = props.ticks.find((tick) => tick.isActive);
    const note = activeTick ? rowKey(activeTick) : (props.home ?? rowKey(props.ticks[0]!));
    const index = props.rows.findIndex((row) => row.note === note);
    scroller.value?.scrollToIndex(Math.max(0, index - 5));
};

/** Maximizing changes the row height, which rebuilds the scroller; bring the pattern back into view afterwards. */
watch(isMaximized, () => void scrollToPattern());

defineExpose({ scrollToPattern });
</script>

<template>
    <Teleport to="body">
        <FloatingWindow
            v-if="visible && frame"
            :state="frame"
            :area="viewport"
            :accent="props.accent"
            :label="props.header"
            fixed
            @focus="bringToFront"
            @close="visible = false"
        >
            <template #title>
                <span class="fwin-title">{{ props.header }}</span>
            </template>
            <div
                class="pianoroll pianoroll--dialog flex flex-col gap-1.5"
                :style="{ '--jl-accent': props.accent, '--jl-roll-beats': beats.length, '--jl-roll-row': `${rowHeight}px` }"
            >
                <div class="pianoroll-ruler" aria-hidden="true">
                    <div class="pianokeys"></div>
                    <div class="steps">
                        <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
                            <div
                                v-for="(step, i) in beat"
                                :key="step"
                                class="ruler-cell"
                                :class="{ 'ruler-cell--dot': i !== 0, 'ruler-cell--current': props.currentTick === step }"
                            >
                                <template v-if="i === 0">{{ beatNumber(beatIndex) }}</template>
                            </div>
                        </div>
                    </div>
                </div>
                <VirtualScroller :items="props.rows as RollRow[]" :item-size="rowHeight" :key="rowHeight" class="pianoroll-scroller" ref="scroller">
                    <template v-slot:item="{ item: row }">
                        <div class="pianorow" :class="{ 'pianorow--black': row.black, 'pianorow--c': row.marked }" :data-note="row.note">
                            <div class="pianokeys">
                                <div class="pianokey">{{ row.label }}</div>
                            </div>
                            <div class="pianolane">
                                <div class="steps">
                                    <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
                                        <div
                                            v-for="tickIndex in beat"
                                            :key="tickIndex"
                                            class="pianotick"
                                            :class="{ 'pianotick--current': props.currentTick === tickIndex, 'pianotick--downbeat': tickIndex % 16 === 0 }"
                                            :data-step="tickIndex"
                                            :title="`Step ${tickIndex + 1}: ${row.label}`"
                                            @click="placeNote(props.ticks[tickIndex]!, row.note)"
                                        ></div>
                                    </div>
                                </div>
                                <div
                                    v-for="bar in rowNotes(row.note)"
                                    :key="bar.head"
                                    class="pianonote"
                                    :class="{ 'pianonote--current': props.currentTick >= bar.head && props.currentTick <= bar.end }"
                                    :style="noteStyle(bar)"
                                    :title="`${row.label}, step ${bar.head + 1}. Drag to move${props.resizable ? ', drag the ends to change the length' : ''}.`"
                                    @pointerdown.stop.prevent="startMove($event, bar.head)"
                                >
                                    <template v-if="props.resizable">
                                        <span
                                            class="note-handle note-handle--start"
                                            title="Drag to move the start"
                                            @pointerdown.stop.prevent="startResize($event, 'start', bar.head)"
                                        ></span>
                                        <span
                                            class="note-handle note-handle--end"
                                            title="Drag to change the length"
                                            @pointerdown.stop.prevent="startResize($event, 'end', bar.head)"
                                        ></span>
                                    </template>
                                </div>
                            </div>
                        </div>
                    </template>
                </VirtualScroller>
                <div class="lane-foot">
                    <slot name="foot" />
                    <span class="lane-hint">{{ props.hint }}</span>
                </div>
            </div>
        </FloatingWindow>
    </Teleport>
</template>
