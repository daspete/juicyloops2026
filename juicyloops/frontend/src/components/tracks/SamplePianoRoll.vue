<script setup lang="ts">
import { ALL_NOTES_DESCENDING, transpose } from '@/juicyloops/notes';
import { SAMPLE_ROOT_NOTE, type SampleTick } from '@/juicyloops/ticks/SampleTick';
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import { computed } from 'vue';
import PianoRoll, { type RollRow } from './PianoRoll.vue';

/**
 * The piano roll of a sampler or microphone track. A sliced sample gets one row per slice, top to bottom;
 * a whole sample gets the keyboard, played at its own pitch on the root and higher or lower around it.
 */
const props = defineProps<{
    track: SampleTrack;
    currentTick: number;
    header: string;
    accent: string;
}>();

const visible = defineModel<boolean>('visible', { required: true });

const CHROMATIC_ROWS: readonly RollRow[] = ALL_NOTES_DESCENDING.map((note) => ({
    note,
    label: note === SAMPLE_ROOT_NOTE ? `${note} · root` : note,
    black: note.includes('#'),
    marked: note === SAMPLE_ROOT_NOTE || (note.startsWith('C') && !note.includes('#')),
}));

const sliceCount = computed(() => props.track.slices.length);

const rows = computed<readonly RollRow[]>(() =>
    sliceCount.value > 1
        ? Array.from({ length: sliceCount.value }, (_, index) => ({ note: transpose(SAMPLE_ROOT_NOTE, index), label: `S${index + 1}`, marked: index === 0 }))
        : CHROMATIC_ROWS,
);

/** A sliced sample shows a note that points past the last slice on the slice it actually plays. */
const rowOf = (tick: SampleTick): string => (sliceCount.value > 1 ? transpose(SAMPLE_ROOT_NOTE, props.track.sliceIndexOf(tick.note)) : tick.note);

const hint = computed(() =>
    sliceCount.value > 1
        ? 'Every row is one slice (S1 is the first). Click a cell to play that slice on that step, drag a note to move it.'
        : 'The sample plays at its own pitch on the root. Click a cell to play it higher or lower, drag a note to move it. Cut the sample into slices to give every part its own row.',
);
</script>

<template>
    <PianoRoll
        v-model:visible="visible"
        :ticks="props.track.ticks"
        :rows="rows"
        :row-of="rowOf"
        :current-tick="props.currentTick"
        :header="props.header"
        :accent="props.accent"
        :home="SAMPLE_ROOT_NOTE"
        :hint="hint"
    />
</template>
