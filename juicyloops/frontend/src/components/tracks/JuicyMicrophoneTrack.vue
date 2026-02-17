<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { Icon } from '@iconify/vue';
import { Button, Slider } from 'primevue';
import { computed, onMounted, ref } from 'vue';
import TrackWaveform from '../trackdetails/waveform/TrackWaveform.vue';
import type { MicrophoneTrack } from '@/juicyloops/tracks/MicrophoneTrack';
import type { MicrophoneTick } from '@/juicyloops/ticks/MicrophoneTick';

const { tracks, removeTrack, currentTick } = useJuicyLoops();

const props = defineProps<{
    trackId: string;
    trackIndex: number;
}>();

const isTrackSettingsExpanded = ref(false);

const track = computed<MicrophoneTrack>(() => tracks.value.find((t) => t.id === props.trackId) as MicrophoneTrack);

onMounted(async () => {});

const updateTick = (tick: MicrophoneTick) => {
    tick.isActive = !tick.isActive;
};

const toggleTrackSettings = () => {
    isTrackSettingsExpanded.value = !isTrackSettingsExpanded.value;
};

const toggleRecording = () => {
    if (track.value.isRecording) {
        track.value.stopRecording();
    } else {
        track.value.startRecording();
    }
};
</script>

<template>
    <div class="pl-2 py-1 pr-6 flex flex-col gap-4 track">
        <div class="flex gap-2 items-start">
            <div class="font-semibold bg-surface-700 flex h-9 rounded px-2 items-center gap-2">
                <Icon icon="mdi:waveform" class="w-5 h-5" />
                <div class="text-xs w-6 text-right">#{{ props.trackIndex + 1 }}</div>
            </div>
            <div class="flex items-center gap-1 rounded bg-surface-700 w-40 h-9">
                <Button size="small" text @click="toggleRecording">
                    <Icon icon="guidance:recording-studio" class="w-5 h-5" />
                </Button>
                <Button size="small" :text="!isTrackSettingsExpanded" @click="toggleTrackSettings">
                    <Icon icon="akar-icons:settings-vertical" class="w-5 h-5" />
                </Button>
                <Button size="small" text>
                    <Icon icon="ic:baseline-settings" class="w-5 h-5" />
                </Button>
                <Button size="small" text @click="removeTrack(track.id)">
                    <Icon icon="mdi:trash" class="w-5 h-5" />
                </Button>
            </div>

            <div class="flex-1 flex flex-col gap-2">
                <div class="w-full grid grid-cols-32 gap-1 justify-stretch items-stretch h-9">
                    <div v-for="(tick, tickIndex) in track.ticks" :key="tickIndex">
                        <div
                            class="w-full h-full rounded flex items-center justify-center cursor-pointer shadow border border-transparent tick"
                            :class="{
                                'tick--active': tick.isActive,
                                'tick--inactive': !tick.isActive,
                                'tick--current': currentTick === tickIndex,
                            }"
                            @click="updateTick(tick)"
                        ></div>
                    </div>
                </div>

                <div class="w-full grid grid-cols-32 gap-1" v-if="isTrackSettingsExpanded">
                    <div v-for="(tick, tickIndex) in track.ticks" :key="tickIndex">
                        <div class="w-full rounded shadow p-2 bg-surface-600 flex flex-col gap-4">
                            <div class="flex flex-col items-center justify-center w-full gap-4">
                                <div>{{ Math.round(tick.volume * 100) }}%</div>
                                <Slider v-model="tick.volume" :min="0" :max="1" :step="0.01" orientation="vertical" class="w-2" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div v-if="track.hasRecordedAudio && !track.isRecording">
            <TrackWaveform :track="track" />
        </div>
    </div>
</template>
