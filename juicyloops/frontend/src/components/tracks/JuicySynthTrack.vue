<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { ALL_NOTES_DESCENDING, nearestNoteLength, noteLengthSteps } from '@/juicyloops/notes';
import type { SynthTick } from '@/juicyloops/ticks/SynthTick';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { Dialog, VirtualScroller } from 'primevue';
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef } from 'vue';
import TickGrid, { type StepSpan } from './TickGrid.vue';
import TrackShell from './TrackShell.vue';
import { beatNumber, beatsOf } from './steps';
import { TRACK_META } from './trackMeta';

const props = defineProps<{
    track: SynthTrack;
    trackIndex: number;
}>();

const { currentTick: playingStep, trackStep, isPlaying } = useJuicyLoops();

/** The playhead inside this track's own pattern; off the grid while stopped, so no pad is lit for nothing. */
const currentTick = computed(() => (isPlaying.value ? trackStep(props.track) : -1));
const sectionStep = computed(() => (isPlaying.value ? playingStep.value : -1));

const beats = computed(() => beatsOf(props.track.length));

/** The piano roll opens in its own window over the workspace; the row keeps just the step grid. */
const isPianoRollExpanded = ref(false);
const isPianoRollMaximized = ref(false);
const accent = TRACK_META.synth.accent;

/* Row height of the roll. The virtual scroller needs the number, the CSS reads the same value. Taller when the roll has the whole screen. */
const ROW_HEIGHT = 28;
const ROW_HEIGHT_MAX = 36;
const rowHeight = computed(() => (isPianoRollMaximized.value ? ROW_HEIGHT_MAX : ROW_HEIGHT));

/** One note bar in a piano roll row: where it starts, how many cells it covers, and how much of a cell a short note fills. */
interface RollNote {
    head: number;
    end: number;
    fill: number;
}

/** Last cell index a note starting at `index` covers. */
const noteEnd = (index: number, steps: number) => Math.min(props.track.length - 1, index + Math.max(1, steps) - 1);

const rowNotes = (note: string): RollNote[] =>
    props.track.ticks.flatMap((tick, index) => {
        if (tick.note !== note || !tick.isActive) {
            return [];
        }
        const steps = noteLengthSteps(tick.duration);
        return [{ head: index, end: noteEnd(index, steps), fill: Math.min(1, steps) }];
    });

/* Where a cell sits inside the row, in the same units the grid is laid out in, so note bars line up with the cells under them. */
const cellLeft = (step: number) => `${Math.floor(step / 4)} * (var(--jl-beat-w) + var(--jl-beat-gap)) + ${step % 4} * (var(--jl-cell-w) + 3px)`;

const noteStyle = (note: RollNote) => ({
    left: `calc(${cellLeft(note.head)})`,
    width: note.fill < 1 ? `calc(var(--jl-cell-w) * ${note.fill})` : `calc(${cellLeft(note.end)} - (${cellLeft(note.head)}) + var(--jl-cell-w))`,
});

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

/** The step cell at a point, also when a note bar is drawn over it. */
const cellUnder = (clientX: number, clientY: number) => {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
        const cell = element.closest<HTMLElement>('[data-step]');
        if (cell) {
            return cell;
        }
    }
    return null;
};

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

/* ---- moving notes around the piano roll ---- */

type Move = { head: number; grab: number; moved: boolean };
let move: Move | null = null;

/** Puts the note at `head` onto another step and pitch. The target step must be free (or the note's own). */
const relocate = (head: number, step: number, note: string): number => {
    const ticks = props.track.ticks;
    const source = ticks[head]!;
    const target = Math.max(0, Math.min(ticks.length - 1, step));
    if (target !== head && ticks[target]!.isActive) {
        return head;
    }
    if (target !== head) {
        const destination = ticks[target]!;
        destination.duration = source.duration;
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
    if (step === move.head && note === props.track.ticks[move.head]!.note) {
        return;
    }
    move.moved = true;
    move.head = relocate(move.head, step, note);
};

const stopMove = () => {
    if (move && !move.moved) {
        // A plain click on a note switches it off, like clicking its cell.
        props.track.ticks[move.head]!.isActive = false;
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

const togglePianoRoll = () => {
    isPianoRollExpanded.value = !isPianoRollExpanded.value;
};

/** Maximizing changes the row height, which rebuilds the scroller; bring the pattern back into view afterwards. */
const resizeRoll = async (maximized: boolean) => {
    isPianoRollMaximized.value = maximized;
    await scrollToPattern();
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
                class="tool"
                :data-active="isPianoRollExpanded"
                v-tooltip.bottom="'Pick the pitch of each step'"
                :aria-pressed="isPianoRollExpanded"
                @click="togglePianoRoll"
            >
                <Icon icon="material-symbols:piano" class="w-4 h-4" />
                <span>Notes</span>
            </button>
        </template>

        <TickGrid
            :ticks="props.track.ticks"
            :current-tick="currentTick"
            :section-step="sectionStep"
            :spans="gridSpans.spans"
            @paint="(tick, _index, active) => (tick.isActive = active)"
        >
            <template #default="{ tick, index }">
                <span class="tick-label">{{ tick.note }}</span>
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
    </TrackShell>

    <Dialog
        v-model:visible="isPianoRollExpanded"
        modal
        maximizable
        dismissable-mask
        :header="`Notes · Synth ${props.trackIndex + 1}`"
        class="pianoroll-dialog"
        :style="{ width: '72rem' }"
        :breakpoints="{ '1280px': '94vw', '640px': '100vw' }"
        @show="scrollToPattern"
        @hide="isPianoRollMaximized = false"
        @maximize="resizeRoll(true)"
        @unmaximize="resizeRoll(false)"
    >
        <div
            class="pianoroll pianoroll--dialog flex flex-col gap-1.5"
            :style="{ '--jl-accent': accent, '--jl-roll-beats': beats.length, '--jl-roll-row': `${rowHeight}px` }"
        >
            <div class="pianoroll-ruler" aria-hidden="true">
                <div class="pianokeys"></div>
                <div class="steps">
                    <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
                        <div
                            v-for="(step, i) in beat"
                            :key="step"
                            class="ruler-cell"
                            :class="{ 'ruler-cell--dot': i !== 0, 'ruler-cell--current': currentTick === step }"
                        >
                            <template v-if="i === 0">{{ beatNumber(beatIndex) }}</template>
                        </div>
                    </div>
                </div>
            </div>
            <VirtualScroller :items="ALL_NOTES_DESCENDING" :item-size="rowHeight" :key="rowHeight" class="pianoroll-scroller" ref="scroller">
                <template v-slot:item="{ item: note }">
                    <div class="pianorow" :class="{ 'pianorow--black': isBlackKey(note), 'pianorow--c': isC(note) }" :data-note="note">
                        <div class="pianokeys">
                            <div class="pianokey">{{ note }}</div>
                        </div>
                        <div class="pianolane">
                            <div class="steps">
                                <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
                                    <div
                                        v-for="tickIndex in beat"
                                        :key="tickIndex"
                                        class="pianotick"
                                        :class="{ 'pianotick--current': currentTick === tickIndex, 'pianotick--downbeat': tickIndex % 16 === 0 }"
                                        :data-step="tickIndex"
                                        :title="`Step ${tickIndex + 1}: ${note}`"
                                        @click="placeNote(props.track.ticks[tickIndex]!, note)"
                                    ></div>
                                </div>
                            </div>
                            <div
                                v-for="bar in rowNotes(note)"
                                :key="bar.head"
                                class="pianonote"
                                :class="{ 'pianonote--current': currentTick >= bar.head && currentTick <= bar.end }"
                                :style="noteStyle(bar)"
                                :title="`${note}, step ${bar.head + 1}. Drag to move, drag the ends to change the length.`"
                                @pointerdown.stop.prevent="startMove($event, bar.head)"
                            >
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
                            </div>
                        </div>
                    </div>
                </template>
            </VirtualScroller>
            <div class="lane-foot">
                <button type="button" class="chip" @click="shiftOctave(-1)">
                    <Icon icon="mdi:arrow-down" class="w-4 h-4" />
                    <span>Octave down</span>
                </button>
                <button type="button" class="chip" @click="shiftOctave(1)">
                    <Icon icon="mdi:arrow-up" class="w-4 h-4" />
                    <span>Octave up</span>
                </button>
                <span class="lane-hint">Click a cell to place a note. Drag a note to move it, drag its ends to change its length.</span>
            </div>
        </div>
    </Dialog>
</template>
