<script setup lang="ts">
import { computed } from 'vue';
import type { PatternNote } from '@/juicyloops/notes/Note';
import type { RollRow } from '../PianoRoll.vue';

/**
 * One note bar of the piano roll. A component of its own so that editing a note re-renders just its bar: it reads
 * the note's fields itself, the list around it only reads ids. Geometry is CSS variables (`--s` start, `--l` length,
 * `--r` row, `--v` velocity), scaled by the roll's `--roll-step` and `--roll-row`.
 */
const props = defineProps<{
    note: PatternNote;
    rows: readonly RollRow[];
    /** The row a note sits on, -1 when the roll has none for it (then it is not drawn). */
    rowFor: (note: PatternNote) => number;
    selected: boolean;
}>();

const row = computed(() => props.rowFor(props.note));
</script>

<template>
    <div
        class="proll-note"
        :class="{ 'proll-note--selected': props.selected }"
        :data-id="props.note.id"
        :hidden="row < 0"
        :style="`--s:${props.note.start};--l:${props.note.length};--r:${row};--v:${props.note.velocity}`"
    >
        <span class="proll-note-label">{{ props.rows[row]?.label }}</span>
        <span class="proll-edge proll-edge--start" data-edge="start"></span>
        <span class="proll-edge proll-edge--end" data-edge="end"></span>
    </div>
</template>
