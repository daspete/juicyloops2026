<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { ALL_NOTES_DESCENDING, nearestNoteLength, noteLengthSteps } from '@/juicyloops/notes';
import { STEP_COUNT } from '@/juicyloops/constants';
import type { SynthTick } from '@/juicyloops/ticks/SynthTick';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { VirtualScroller } from 'primevue';
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef } from 'vue';
import TickGrid, { type StepSpan } from './TickGrid.vue';
import TrackShell from './TrackShell.vue';
import SynthEnvelopeSettings from './settings/SynthEnvelopeSettings.vue';
import SynthSettings from './settings/SynthSettings.vue';
import { BEATS } from './steps';

const props = defineProps<{
    track: SynthTrack;
    trackIndex: number;
}>();

const { currentTick } = useJuicyLoops();

const ROW_HEIGHT = 24;

const isPianoRollExpanded = ref(false);

/**
 * What each cell of one piano roll row shows: the head of a note (with the fraction of the cell it fills),
 * the tail of a longer note from an earlier step, or nothing.
 */
type RollCell = { kind: 'head'; fill: number; isEnd: boolean; head: number } | { kind: 'tail'; isEnd: boolean; head: number } | { kind: 'ghost' } | null;

/** Last cell index a note starting at `index` covers. */
const noteEnd = (index: number, steps: number) => Math.min(STEP_COUNT - 1, index + Math.max(1, steps) - 1);

const rowCells = (note: string): RollCell[] => {
    const cells: RollCell[] = props.track.ticks.map((tick) => (tick.note === note && !tick.isActive ? { kind: 'ghost' } : null));
    props.track.ticks.forEach((tick, index) => {
        if (tick.note !== note || !tick.isActive) {
            return;
        }
        const steps = noteLengthSteps(tick.duration);
        const end = noteEnd(index, steps);
        cells[index] = { kind: 'head', fill: Math.min(1, steps), isEnd: end === index, head: index };
        for (let cell = index + 1; cell <= end; cell++) {
            if (cells[cell]?.kind !== 'head') {
                cells[cell] = { kind: 'tail', isEnd: cell === end, head: index };
            }
        }
    });
    return cells;
};

/** Decoration of the main grid: which cells are covered by longer notes, and where each note ends (for the end handle). */
const gridSpans = computed(() => {
    const spans = new Map<number, StepSpan>();
    const endHead = new Map<number, number>();
    props.track.ticks.forEach((tick, index) => {
        if (!tick.isActive) {
            return;
        }
        const steps = noteLengthSteps(tick.duration);
        const end = noteEnd(index, steps);
        endHead.set(end, index);
        spans.set(index, { ...spans.get(index), fill: Math.min(1, steps), openEnd: end > index });
        for (let cell = index + 1; cell <= end; cell++) {
            spans.set(cell, { ...spans.get(cell), tail: true, openEnd: cell < end });
        }
    });
    return { spans, endHead };
});

/* ---- resizing notes by their handles ---- */

type Resize = { edge: 'start' | 'end'; head: number; anchorY: number };
let resize: Resize | null = null;

const cellUnder = (clientX: number, clientY: number) => document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-step]') ?? null;

const onResizeMove = (event: PointerEvent) => {
    if (!resize) {
        return;
    }

    const cell = cellUnder(event.clientX, resize.anchorY);
    if (!cell) {
        return;
    }

    const step = Number(cell.dataset.step);
    const tick = props.track.ticks[resize.head]!;

    if (resize.edge === 'end') {
        if (step <= resize.head) {
            // Inside the note's own cell: the horizontal position picks a fraction of a step.
            const rect = cell.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / rect.width;
            tick.duration = ratio < 0.375 ? '64n' : ratio < 0.75 ? '32n' : '16n';
        } else {
            tick.duration = nearestNoteLength(step - resize.head + 1);
        }
        return;
    }

    const end = noteEnd(resize.head, noteLengthSteps(tick.duration));
    const start = Math.min(step, end);
    const length = nearestNoteLength(Math.max(1, end - start + 1));

    if (start === resize.head) {
        tick.duration = length;
        return;
    }

    // The start moved: the note now lives on another step.
    const target = props.track.ticks[start]!;
    target.note = tick.note;
    target.isActive = true;
    target.duration = length;
    tick.isActive = false;
    resize.head = start;
};

const stopResize = () => {
    resize = null;
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', stopResize);
};

const startResize = (event: PointerEvent, edge: 'start' | 'end', head: number) => {
    if (event.button !== 0) {
        return;
    }
    resize = { edge, head, anchorY: event.clientY };
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', stopResize);
};

onBeforeUnmount(stopResize);
const scroller = useTemplateRef<InstanceType<typeof VirtualScroller>>('scroller');

/** In the piano roll, clicking a tick's own note toggles it, clicking another note moves the tick there and activates it. */
const placeNote = (tick: SynthTick, note: string) => {
    if (tick.note === note) {
        tick.isActive = !tick.isActive;
        return;
    }

    tick.isActive = true;
    tick.note = note;
};

const isBlackKey = (note: string) => note.includes('#');
const isC = (note: string) => note.startsWith('C') && !isBlackKey(note);

/** Scrolls the roll so the pattern's notes are in view (or C5 when nothing is set yet). */
const scrollToPattern = async () => {
    await nextTick();

    const activeTick = props.track.ticks.find((tick) => tick.isActive);
    const note = activeTick?.note ?? props.track.ticks[0]?.note ?? 'C5';
    const index = ALL_NOTES_DESCENDING.indexOf(note);
    scroller.value?.scrollToIndex(Math.max(0, index - 5));
};

const togglePianoRoll = async () => {
    isPianoRollExpanded.value = !isPianoRollExpanded.value;
    if (isPianoRollExpanded.value) {
        await scrollToPattern();
    }
};

const shiftOctave = async (direction: 1 | -1) => {
    props.track.shiftOctave(direction);
    await scrollToPattern();
};
</script>

<template>
    <TrackShell :track="props.track" :track-index="props.trackIndex" has-grid>
        <template #actions>
            <button
                type="button"
                class="iconbtn"
                :data-active="isPianoRollExpanded"
                v-tooltip.bottom="'Pick the pitch of each step'"
                :aria-pressed="isPianoRollExpanded"
                @click="togglePianoRoll"
            >
                <Icon icon="material-symbols:piano" class="w-4 h-4" />
                <span>Notes</span>
            </button>
        </template>

        <TickGrid :ticks="props.track.ticks" :current-tick="currentTick" :spans="gridSpans.spans" @paint="(tick, _index, active) => (tick.isActive = active)">
            <template #default="{ tick, index }">
                <span>{{ tick.note }}</span>
                <span
                    v-if="tick.isActive"
                    class="note-handle note-handle--start"
                    title="Drag to move the start"
                    @pointerdown.stop.prevent="startResize($event, 'start', index)"
                    @click.stop
                ></span>
                <span
                    v-if="gridSpans.endHead.has(index)"
                    class="note-handle note-handle--end"
                    title="Drag to change the length"
                    @pointerdown.stop.prevent="startResize($event, 'end', gridSpans.endHead.get(index)!)"
                    @click.stop
                ></span>
            </template>
        </TickGrid>

        <div v-if="isPianoRollExpanded" class="pianoroll flex flex-col gap-1.5">
            <VirtualScroller :items="ALL_NOTES_DESCENDING" :item-size="ROW_HEIGHT" class="h-72 -mr-1.5" ref="scroller">
                <template v-slot:item="{ item: note }">
                    <div class="pianorow" :class="{ 'pianorow--black': isBlackKey(note), 'pianorow--c': isC(note) }">
                        <div class="pianokey">{{ note }}</div>
                        <div v-for="(cells, cellsKey) in [rowCells(note)]" :key="cellsKey" class="steps">
                            <template v-for="(beat, beatIndex) in BEATS" :key="beatIndex">
                                <div class="beat">
                                    <div
                                        v-for="tickIndex in beat"
                                        :key="tickIndex"
                                        class="pianotick"
                                        :class="{
                                            'pianotick--active': cells[tickIndex]?.kind === 'head',
                                            'pianotick--tail': cells[tickIndex]?.kind === 'tail',
                                            'pianotick--open-end': (cells[tickIndex]?.kind === 'head' || cells[tickIndex]?.kind === 'tail') && !(cells[tickIndex] as { isEnd: boolean }).isEnd,
                                            'pianotick--ghost': cells[tickIndex]?.kind === 'ghost',
                                            'pianotick--current': currentTick === tickIndex,
                                        }"
                                        :style="cells[tickIndex]?.kind === 'head' ? { '--fill': (cells[tickIndex] as { fill: number }).fill } : undefined"
                                        :data-step="tickIndex"
                                        :title="`Step ${tickIndex + 1}: ${note}`"
                                        @click="placeNote(props.track.ticks[tickIndex]!, note)"
                                    >
                                        <span
                                            v-if="cells[tickIndex]?.kind === 'head'"
                                            class="note-handle note-handle--start"
                                            title="Drag to move the start"
                                            @pointerdown.stop.prevent="startResize($event, 'start', tickIndex)"
                                            @click.stop
                                        ></span>
                                        <span
                                            v-if="(cells[tickIndex]?.kind === 'head' || cells[tickIndex]?.kind === 'tail') && (cells[tickIndex] as { isEnd: boolean }).isEnd"
                                            class="note-handle note-handle--end"
                                            title="Drag to change the length"
                                            @pointerdown.stop.prevent="startResize($event, 'end', (cells[tickIndex] as { head: number }).head)"
                                            @click.stop
                                        ></span>
                                    </div>
                                </div>
                            </template>
                        </div>
                    </div>
                </template>
            </VirtualScroller>
            <div class="flex items-center gap-2 pl-15">
                <button type="button" class="chip" @click="shiftOctave(-1)">
                    <Icon icon="mdi:arrow-down" class="w-4 h-4" />
                    <span>Octave down</span>
                </button>
                <button type="button" class="chip" @click="shiftOctave(1)">
                    <Icon icon="mdi:arrow-up" class="w-4 h-4" />
                    <span>Octave up</span>
                </button>
                <span class="text-xs text-(--jl-muted)">Click a cell to place a note. Drag a note's ends to change its length, outlined cells are silent steps.</span>
            </div>
        </div>

        <template #sound>
            <SynthSettings :track="props.track" />
            <SynthEnvelopeSettings :track="props.track" />
        </template>
    </TrackShell>
</template>
