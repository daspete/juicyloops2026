<script setup lang="ts">
import type { PatternNote } from '@/juicyloops/notes/Note';
import type { RollRow } from '../PianoRoll.vue';
import RollNote from './RollNote.vue';

/**
 * The note bars of the piano roll. Its own component, so the roll's header, keys and grid do not re-render with every
 * note edit. It reads only the list and the ids; each bar reads its note (see `RollNote`), so moving, resizing or
 * re-voicing one note re-renders one bar. Adding, removing or reordering notes walks the list, and `v-memo` keeps
 * that walk to a comparison per note.
 */
const props = defineProps<{
    notes: readonly PatternNote[];
    rows: readonly RollRow[];
    rowFor: (note: PatternNote) => number;
    selected: ReadonlySet<string>;
}>();
</script>

<template>
    <RollNote
        v-for="note in props.notes"
        :key="note.id"
        v-memo="[props.selected.has(note.id), props.rows, props.rowFor]"
        :note="note"
        :rows="props.rows"
        :row-for="props.rowFor"
        :selected="props.selected.has(note.id)"
    />
</template>
