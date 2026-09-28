<script setup lang="ts">
import type { PatternNote } from '@/juicyloops/notes/Note';
import RollStem from './RollStem.vue';

/** The velocity stems of the piano roll, one per note; built like `RollNoteLayer`. */
const props = defineProps<{
    notes: readonly PatternNote[];
    /** Whether the roll has a row for the note; the others are not drawn. */
    isShown: (note: PatternNote) => boolean;
    selected: ReadonlySet<string>;
}>();
</script>

<template>
    <RollStem
        v-for="note in props.notes"
        :key="note.id"
        v-memo="[props.selected.has(note.id), props.selected.size > 0, props.isShown]"
        :note="note"
        :hidden="!props.isShown(note)"
        :selected="props.selected.has(note.id)"
        :dim="props.selected.size > 0 && !props.selected.has(note.id)"
    />
</template>
