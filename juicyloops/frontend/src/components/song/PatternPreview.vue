<script setup lang="ts">
import { stepOfStart, type PatternNote } from '@/juicyloops/notes/Note';
import { stepCells, stepVelocity } from '@/juicyloops/notes/stepView';
import { computed } from 'vue';

/**
 * A thumbnail of a track's pattern: one sliver per step, lit when a note starts in it, as tall as its velocity, and
 * shifted to where inside the step the note starts.
 */
const props = defineProps<{
    notes: readonly PatternNote[];
    length: number;
}>();

const steps = computed(() =>
    stepCells(props.notes, props.length).map((notes, index) => ({
        on: notes.length > 0,
        downbeat: index % 4 === 0,
        level: Math.max(0.25, stepVelocity(notes)),
        offset: notes[0] ? notes[0].start - stepOfStart(notes[0].start) : 0,
    })),
);
</script>

<template>
    <div class="preview" :style="{ gridTemplateColumns: `repeat(${props.length}, minmax(0, 1fr))` }" aria-hidden="true">
        <span
            v-for="(step, index) in steps"
            :key="index"
            class="preview-step"
            :data-on="step.on"
            :data-downbeat="step.downbeat"
            :style="step.on ? { '--level': step.level, '--offset': step.offset } : undefined"
        ></span>
    </div>
</template>
