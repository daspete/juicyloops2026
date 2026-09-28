<script setup lang="ts">
import type { PatternNote } from '@/juicyloops/notes/Note';

/** One velocity stem of the piano roll; like `RollNote`, it re-renders alone when its note changes. */
const props = defineProps<{
    note: PatternNote;
    hidden: boolean;
    selected: boolean;
    /** Another note is selected: this one fades, lane edits then only reach the selection. */
    dim: boolean;
}>();
</script>

<template>
    <div
        class="proll-stem"
        :class="{ 'proll-stem--selected': props.selected, 'proll-stem--dim': props.dim }"
        :hidden="props.hidden"
        :style="`--s:${props.note.start};--v:${props.note.velocity}`"
    ></div>
</template>
