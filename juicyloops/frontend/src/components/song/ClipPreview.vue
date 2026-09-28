<script setup lang="ts">
import { computed } from 'vue';
import { stepOfStart } from '@/juicyloops/notes/Note';
import { stepCells, stepVelocity } from '@/juicyloops/notes/stepView';
import type { TrackContainer } from '@/juicyloops/trackContainer';

/**
 * What a clip actually plays: one thin row per track, one sliver per timeline step (lit where a note starts, at its
 * real position inside the step), at the timeline's own scale.
 * The rows start `offset` steps into the patterns and wrap around each track's length, exactly like playback,
 * so resizing or cutting the clip reveals or hides notes instead of stretching them.
 */
const props = defineProps<{
    container: TrackContainer;
    offset: number;
    length: number;
}>();

const MAX_ROWS = 4;

const rows = computed(() =>
    props.container.tracks.slice(0, MAX_ROWS).map((track) => {
        const cells = stepCells(track.notes, track.length);
        return {
            id: track.id,
            steps: Array.from({ length: props.length }, (_, i) => {
                const notes = cells[track.stepOf(props.offset + i)]!;
                const first = notes[0];
                return {
                    on: notes.length > 0,
                    level: Math.max(0.25, stepVelocity(notes)),
                    // A note between steps sits where it starts.
                    offset: first ? first.start - stepOfStart(first.start) : 0,
                    downbeat: (props.offset + i) % 4 === 0,
                };
            }),
        };
    }),
);
</script>

<template>
    <div class="clip-preview" aria-hidden="true">
        <div v-for="row in rows" :key="row.id" class="preview preview--scaled" :style="{ gridTemplateColumns: `repeat(${row.steps.length}, var(--jl-song-step))` }">
            <span
                v-for="(step, index) in row.steps"
                :key="index"
                class="preview-step"
                :data-on="step.on"
                :data-downbeat="step.downbeat"
                :style="step.on ? { '--level': step.level, '--offset': step.offset } : undefined"
            ></span>
        </div>
    </div>
</template>
