<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { MicrophoneTrack } from '@/juicyloops/tracks/MicrophoneTrack';
import { Icon } from '@iconify/vue';
import { computed, ref } from 'vue';
import TickGrid from './TickGrid.vue';
import TrackShell from './TrackShell.vue';
import TrackWaveform from './settings/TrackWaveform.vue';

const props = defineProps<{
    track: MicrophoneTrack;
    trackIndex: number;
}>();

const { currentTick: playingStep, trackStep, isPlaying } = useJuicyLoops();

/** The playhead inside this track's own pattern; off the grid while stopped, so no pad is lit for nothing. */
const currentTick = computed(() => (isPlaying.value ? trackStep(props.track) : -1));
const sectionStep = computed(() => (isPlaying.value ? playingStep.value : -1));

const isWaveformExpanded = ref(false);

const recordLabel = computed(() => {
    if (props.track.isRecording) {
        return 'Stop recording';
    }
    return props.track.hasSample ? 'Record again' : 'Record';
});

const toggleRecording = async () => {
    const wasRecording = props.track.isRecording;
    await props.track.toggleRecording();
    if (wasRecording) {
        isWaveformExpanded.value = true;
    }
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
                v-tooltip.bottom="'Trim the part of the recording that plays'"
                :aria-pressed="isWaveformExpanded"
                @click="isWaveformExpanded = !isWaveformExpanded"
            >
                <Icon icon="mdi:waveform" class="w-4 h-4" />
                <span>Trim</span>
            </button>
        </template>

        <TickGrid v-if="props.track.hasSample" :ticks="props.track.ticks" :current-tick="currentTick" :section-step="sectionStep" @paint="(tick, _index, active) => (tick.isActive = active)" />
        <div v-else class="track-steps track-empty">
            <button type="button" class="recbtn" :data-recording="props.track.isRecording" @click="toggleRecording">
                <span class="rec-dot"></span>
                <span>{{ recordLabel }}</span>
            </button>
            <span class="lane-hint">
                {{ props.track.isRecording ? 'Listening. Press again when you are done.' : 'Your browser will ask for microphone access.' }}
            </span>
        </div>

        <template #expanded>
            <div v-if="props.track.hasSample && isWaveformExpanded" class="lane-stack">
                <TrackWaveform v-if="!props.track.isRecording" :track="props.track" />
                <div class="lane-foot">
                    <button type="button" class="recbtn" :data-recording="props.track.isRecording" @click="toggleRecording">
                        <span class="rec-dot"></span>
                        <span>{{ recordLabel }}</span>
                    </button>
                    <span class="lane-hint">Drag the highlighted region to choose which part plays.</span>
                </div>
            </div>
        </template>

    </TrackShell>
</template>
