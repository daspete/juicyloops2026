<script setup lang="ts">
import type { TrackContainer } from '@/juicyloops/trackContainer';
import { TRACK_META } from '../tracks/trackMeta';
import PatternPreview from './PatternPreview.vue';

/** A thumbnail of a whole container: one thin pattern preview per track, in the track's colour. */
defineProps<{
    container: TrackContainer;
    /** Draw every track in the ink colour instead of its own accent, for use on a coloured cell. */
    ink?: boolean;
}>();

const MAX_ROWS = 4;
</script>

<template>
    <div class="cpreview" :data-ink="ink" aria-hidden="true">
        <PatternPreview
            v-for="track in container.tracks.slice(0, MAX_ROWS)"
            :key="track.id"
            :ticks="track.ticks"
            :style="ink ? undefined : { '--preview-on': TRACK_META[track.type].accent }"
        />
        <span v-if="!container.tracks.length" class="cpreview-empty">no tracks</span>
    </div>
</template>
