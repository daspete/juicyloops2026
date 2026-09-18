<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { Icon } from '@iconify/vue';
import { ref, watch } from 'vue';
import TickGrid from './TickGrid.vue';
import TrackShell from './TrackShell.vue';
import SamplerFileUpload from './settings/SamplerFileUpload.vue';
import TrackSampleSettings from './settings/TrackSampleSettings.vue';
import TrackWaveform from './settings/TrackWaveform.vue';

const props = defineProps<{
    track: SamplerTrack;
    trackIndex: number;
}>();

const { currentTick } = useJuicyLoops();

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
                class="iconbtn"
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

        <TickGrid v-if="props.track.hasSample" :ticks="props.track.ticks" :current-tick="currentTick" @paint="(tick, _index, active) => (tick.isActive = active)" />
        <div
            v-else
            class="dropzone h-15 flex items-center gap-3 px-3"
            :data-over="isDragOver"
            @dragover.prevent="isDragOver = true"
            @dragleave="isDragOver = false"
            @drop.prevent="onDrop"
        >
            <Icon icon="mdi:tray-arrow-down" class="w-5 h-5 shrink-0" />
            <span class="text-sm">Drop an audio file here, or</span>
            <SamplerFileUpload :track="props.track" label="Choose a file" />
        </div>

        <template #expanded>
            <div v-if="props.track.hasSample && !props.track.isUpdatingSample && isWaveformExpanded" class="flex flex-col gap-2">
                <TrackWaveform :track="props.track" />
                <div class="flex items-center gap-3">
                    <span class="font-mono text-xs px-2 py-1 rounded-md bg-(--jl-cell) max-w-48 truncate" :title="props.track.sampleName ?? ''">{{ props.track.sampleName }}</span>
                    <SamplerFileUpload :track="props.track" label="Change sample" />
                    <span class="text-xs text-(--jl-muted)">Drag the highlighted region to choose which part plays.</span>
                </div>
            </div>
        </template>

        <template #sound>
            <TrackSampleSettings :track="props.track" />
        </template>
    </TrackShell>
</template>
