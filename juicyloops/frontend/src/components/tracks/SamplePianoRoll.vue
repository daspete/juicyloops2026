<script setup lang="ts">
import { ALL_NOTES_DESCENDING, SAMPLE_ROOT_NOTE, transpose } from '@/juicyloops/notes';
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import type { TrackPlayhead } from '@/composables/useContainerView';
import PianoRoll, { type RollRow } from './PianoRoll.vue';

/**
 * The piano roll of a sampler or microphone track. A sliced sample gets one row per slice, top to bottom;
 * a whole sample gets the keyboard, played at its own pitch on the root and higher or lower around it.
 * The footer switches between one-shot (every note plays its slice out) and gate (a note stops at its end).
 */
const props = defineProps<{
    track: SampleTrack;
    playhead: TrackPlayhead;
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

const LENGTH_MODES = [
    { gate: false, icon: 'mdi:ray-start-arrow', label: 'One-shot', hint: 'Every note plays its slice out, whatever its length' },
    { gate: true, icon: 'mdi:ray-start-end', label: 'Gate', hint: 'A note stops its slice when the note ends' },
] as const;

const sliceCount = computed(() => props.track.slices.length);

const rows = computed<readonly RollRow[]>(() =>
    sliceCount.value > 1
        ? Array.from({ length: sliceCount.value }, (_, index) => ({ note: transpose(SAMPLE_ROOT_NOTE, index), label: `S${index + 1}`, marked: index === 0 }))
        : CHROMATIC_ROWS,
);

/** A sliced sample shows a note that points past the last slice on the slice it actually plays. */
const rowOf = (note: string): string => (sliceCount.value > 1 ? transpose(SAMPLE_ROOT_NOTE, props.track.sliceIndexOf(note)) : note);

const hint = computed(() =>
    sliceCount.value > 1
        ? 'Every row is one slice (S1 is the first). Click to add a note, drag it to move, drag its ends to change its length (Alt: no snap).'
        : 'The sample plays at its own pitch on the root. Click to add a note higher or lower, drag it to move, drag its ends to change its length (Alt: no snap).',
);
</script>

<template>
    <PianoRoll
        v-model:visible="visible"
        :pattern="props.track"
        :roll-id="props.track.id"
        :rows="rows"
        :row-of="rowOf"
        :playhead="props.playhead"
        :header="props.header"
        :accent="props.accent"
        :home="SAMPLE_ROOT_NOTE"
        :hint="hint"
    >
        <template #foot>
            <div class="proll-modes" role="group" aria-label="Note length">
                <button
                    v-for="mode in LENGTH_MODES"
                    :key="mode.label"
                    type="button"
                    class="chip"
                    :data-active="props.track.gate === mode.gate"
                    :aria-pressed="props.track.gate === mode.gate"
                    v-tooltip.top="mode.hint"
                    @click="props.track.setGate(mode.gate)"
                >
                    <Icon :icon="mode.icon" class="w-4 h-4" />
                    <span>{{ mode.label }}</span>
                </button>
            </div>
        </template>
    </PianoRoll>
</template>
