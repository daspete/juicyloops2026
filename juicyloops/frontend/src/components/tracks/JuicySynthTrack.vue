<script setup lang="ts">
import { useTrackPlayhead } from '@/composables/useContainerView';
import { ALL_NOTES_DESCENDING, noteLengthSteps } from '@/juicyloops/notes';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { computed, ref, useTemplateRef } from 'vue';
import PianoRoll, { type RollRow } from './PianoRoll.vue';
import TickGrid, { type StepSpan } from './TickGrid.vue';
import TrackShell from './TrackShell.vue';
import { noteEnd, useNoteResize } from './noteDrag';
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

/** Decoration of the main grid: which cells are covered by longer notes, and where each note ends (for the end handle). */
const gridSpans = computed(() => {
    const spans = new Map<number, StepSpan>();
    const endHead = new Map<number, number>();
    props.track.ticks.forEach((tick, index) => {
        if (!tick.isActive) {
            return;
        }
        const steps = noteLengthSteps(tick.duration);
        const end = noteEnd(props.track.length, index, steps);
        endHead.set(end, index);
        spans.set(index, { ...spans.get(index), fill: Math.min(1, steps), openEnd: end > index });
        for (let cell = index + 1; cell <= end; cell++) {
            spans.set(cell, { ...spans.get(cell), tail: true, openEnd: cell < end });
        }
    });
    return { spans, endHead };
});

const { startResize } = useNoteResize(() => props.track.ticks);

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

        <TickGrid
            :ticks="props.track.ticks"
            :playhead="playhead"
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

    <PianoRoll
        ref="roll"
        v-model:visible="isPianoRollExpanded"
        :ticks="props.track.ticks"
        :rows="ROWS"
        :playhead="playhead"
        :header="`Notes · Synth ${props.trackIndex + 1}`"
        :accent="accent"
        home="C5"
        resizable
        hint="Click a cell to place a note. Drag a note to move it, drag its ends to change its length."
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
