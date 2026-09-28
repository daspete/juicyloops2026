<script setup lang="ts">
import { useTrackPlayhead } from '@/composables/useContainerView';
import { ALL_NOTES_DESCENDING } from '@/juicyloops/notes';
import { stepOfStart } from '@/juicyloops/notes/Note';
import { lastCellOf, setStep, stepCells } from '@/juicyloops/notes/stepView';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { computed, ref, useTemplateRef } from 'vue';
import PianoRoll, { type RollRow } from './PianoRoll.vue';
import TickGrid, { type StepSpan } from './TickGrid.vue';
import TrackShell from './TrackShell.vue';
import { useNoteResize } from './noteDrag';
import { TRACK_META } from './trackMeta';

const props = defineProps<{
    track: SynthTrack;
    trackIndex: number;
}>();


/** The playhead inside this track's own pattern and inside the ruler's section; off the grid while silent, so no pad is lit for nothing. */
const playhead = useTrackPlayhead(() => props.track);

/** The piano roll opens in its own window over the workspace; the row keeps just the step grid. */
const isPianoRollExpanded = ref(false);
const accent = TRACK_META.synth.accent;

const ROWS: readonly RollRow[] = ALL_NOTES_DESCENDING.map((note) => ({
    note,
    label: note,
    black: note.includes('#'),
    marked: note.startsWith('C') && !note.includes('#'),
}));

/** The notes starting in each step: what the grid lights. */
const cells = computed(() => stepCells(props.track.notes, props.track.length));

/** Decoration of the main grid: which cells are covered by longer notes, and which note ends in a cell (for the end handle). */
const gridSpans = computed(() => {
    const spans = new Map<number, StepSpan>();
    const endNote = new Map<number, string>();
    for (const note of props.track.notes) {
        const head = stepOfStart(note.start);
        const end = lastCellOf(note, props.track.length);
        endNote.set(end, note.id);
        const own = spans.get(head);
        spans.set(head, { ...own, fill: Math.max(own?.fill ?? 0, Math.min(1, note.length)), openEnd: !!own?.openEnd || end > head });
        for (let cell = head + 1; cell <= end; cell++) {
            spans.set(cell, { ...spans.get(cell), tail: true, openEnd: !!spans.get(cell)?.openEnd || cell < end });
        }
    }
    return { spans, endNote };
});

const { startResize } = useNoteResize(() => props.track);

/* PianoRoll is generic, so its instance type cannot be named; what we call on it is enough. */
const roll = useTemplateRef<{ scrollToPattern: () => Promise<void> }>('roll');

const togglePianoRoll = () => {
    isPianoRollExpanded.value = !isPianoRollExpanded.value;
};

const shiftOctave = async (direction: 1 | -1) => {
    props.track.shiftOctave(direction);
    await roll.value?.scrollToPattern();
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

        <TickGrid :cells="cells" :playhead="playhead" :spans="gridSpans.spans" @paint="(index, active) => setStep(props.track, index, active)">
            <template #default="{ notes, index }">
                <span class="tick-label">{{ notes[0]?.note ?? props.track.stepNote }}</span>
                <span
                    v-if="notes.length"
                    class="note-handle note-handle--start"
                    title="Drag to move the start"
                    @pointerdown.stop.prevent="startResize($event, 'start', notes[0]!.id)"
                    @click.stop
                ></span>
                <span
                    v-if="gridSpans.endNote.has(index)"
                    class="note-handle note-handle--end"
                    title="Drag to change the length"
                    @pointerdown.stop.prevent="startResize($event, 'end', gridSpans.endNote.get(index)!)"
                    @click.stop
                ></span>
            </template>
        </TickGrid>
    </TrackShell>

    <PianoRoll
        ref="roll"
        v-model:visible="isPianoRollExpanded"
        :pattern="props.track"
        :roll-id="props.track.id"
        :rows="ROWS"
        :playhead="playhead"
        :header="`Notes · Synth ${props.trackIndex + 1}`"
        :accent="accent"
        home="C5"
        hint="Click to add a note, drag it to move, drag its ends to change its length (Alt: no snap). Drag over empty space to select."
    >
        <template #foot>
            <button type="button" class="chip" @click="shiftOctave(-1)">
                <Icon icon="mdi:arrow-down" class="w-4 h-4" />
                <span>Octave down</span>
            </button>
            <button type="button" class="chip" @click="shiftOctave(1)">
                <Icon icon="mdi:arrow-up" class="w-4 h-4" />
                <span>Octave up</span>
            </button>
        </template>
    </PianoRoll>
</template>
