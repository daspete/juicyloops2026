<script setup lang="ts">
import { computed } from 'vue';
import type { TrackContainer } from '@/juicyloops/trackContainer';

/**
 * What a clip actually plays: one thin row per track, one sliver per timeline step, at the timeline's own scale.
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
    props.container.tracks.slice(0, MAX_ROWS).map((track) => ({
        id: track.id,
        steps: Array.from({ length: props.length }, (_, i) => {
            const tick = track.ticks[track.stepOf(props.offset + i)]!;
            return { on: tick.isActive, level: Math.max(0.25, tick.volume), downbeat: (props.offset + i) % 4 === 0 };
        }),
    })),
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
                :style="step.on ? { '--level': step.level } : undefined"
            ></span>
        </div>
    </div>
</template>
