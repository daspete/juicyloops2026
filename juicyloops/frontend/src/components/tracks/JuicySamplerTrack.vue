<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { Icon } from '@iconify/vue';
import { computed, ref, watch } from 'vue';
import TickGrid from './TickGrid.vue';
import TrackShell from './TrackShell.vue';
import SamplerFileUpload from './settings/SamplerFileUpload.vue';
import TrackWaveform from './settings/TrackWaveform.vue';

const props = defineProps<{
    track: SamplerTrack;
    trackIndex: number;
}>();

const { currentTick: playingStep, trackStep, isPlaying } = useJuicyLoops();

/** The playhead inside this track's own pattern; off the grid while stopped, so no pad is lit for nothing. */
const currentTick = computed(() => (isPlaying.value ? trackStep(props.track) : -1));
const sectionStep = computed(() => (isPlaying.value ? playingStep.value : -1));

const isWaveformExpanded = ref(false);
const isDragOver = ref(false);

/** Show the waveform as soon as the first sample lands, so the trim region is discoverable. */
watch(
    () => props.track.hasSample,
    (hasSample) => hasSample && (isWaveformExpanded.value = true),
);

const onDrop = async (event: DragEvent) => {
    isDragOver.value = false;
    const file = event.dataTransfer?.files[0];
    if (!file || !file.type.startsWith('audio/')) {
        return;
    }

    await props.track.setFile(file);
};
</script>

<template>
    <TrackShell :track="props.track" :track-index="props.trackIndex" :has-grid="props.track.hasSample">
        <template #actions>
            <button
                type="button"
                class="tool"
                :disabled="!props.track.hasSample"
                :data-active="isWaveformExpanded"
                v-tooltip.bottom="'Trim the part of the sample that plays'"
                :aria-pressed="isWaveformExpanded"
                @click="isWaveformExpanded = !isWaveformExpanded"
            >
                <Icon icon="mdi:waveform" class="w-4 h-4" />
                <span>Trim</span>
            </button>
        </template>

        <TickGrid v-if="props.track.hasSample" :ticks="props.track.ticks" :current-tick="currentTick" :section-step="sectionStep" @paint="(tick, _index, active) => (tick.isActive = active)" />
        <div
            v-else
            class="dropzone track-steps"
            :data-over="isDragOver"
            @dragover.prevent="isDragOver = true"
            @dragleave="isDragOver = false"
            @drop.prevent="onDrop"
        >
            <Icon icon="mdi:tray-arrow-down" class="w-5 h-5 shrink-0" />
            <span>Drop an audio file here, or</span>
            <SamplerFileUpload :track="props.track" label="Choose a file" />
        </div>

        <template #expanded>
            <div v-if="props.track.hasSample && !props.track.isUpdatingSample && isWaveformExpanded" class="lane-stack">
                <TrackWaveform :track="props.track" />
                <div class="lane-foot">
                    <span class="setting-file" :title="props.track.sampleName ?? ''">{{ props.track.sampleName }}</span>
                    <SamplerFileUpload :track="props.track" label="Change sample" />
                    <span class="lane-hint">Drag the highlighted region to choose which part plays.</span>
                </div>
            </div>
        </template>

    </TrackShell>
</template>
