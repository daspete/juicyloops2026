<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { type SamplerTickSettings, SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { Icon } from '@iconify/vue';
import { Button, FileUpload, Slider, type FileUploadSelectEvent } from 'primevue';
import { computed, onMounted, ref } from 'vue';
import SamplerTrackWaveform from '../trackdetails/sampler/SamplerTrackWaveform.vue';

const { tracks, removeTrack, selectedTrack, currentTick } = useJuicyLoops();

const props = defineProps<{
    trackId: string;
}>();

const isTrackSettingsExpanded = ref(false);

const track = computed<SamplerTrack>(() => tracks.value.find((t) => t.id === props.trackId) as SamplerTrack);

onMounted(async () => {});

const updateTick = (tick: SamplerTickSettings) => {
    tick.isActive = !tick.isActive;
};

const onFileSelect = async (event: FileUploadSelectEvent) => {
    const file = Array.isArray(event.files) ? event.files[0] : event.files;

    if (!file) {
        return;
    }

    const fileReader = new FileReader();
    fileReader.onload = async (e) => {
        const result = e.target?.result;
        if (!result) {
            return;
        }
        track.value.setSampleFromArrayBuffer(result as ArrayBuffer);
        track.value.setSampleName(file.name);
        track.value.setFile(file);
    };
    fileReader.readAsArrayBuffer(file);
};

const selectCurrentTrack = () => {
    selectedTrack.value = track.value as unknown as BaseTrack;
};

const toggleTrackSettings = () => {
    isTrackSettingsExpanded.value = !isTrackSettingsExpanded.value;
};
</script>

<template>
    <div
        class="pl-2 py-1 pr-6 flex flex-col gap-4 track"
        :class="{
            'track--selected': selectedTrack?.id === track.id,
        }"
    >
        <div class="flex gap-2 items-start">
            <div class="font-semibold bg-surface-700 flex h-9 rounded px-2 items-center">
                <Icon icon="mdi:waveform" class="w-5 h-5" />
            </div>
            <div class="flex items-center gap-1 rounded bg-surface-700 w-40 h-9">
                <FileUpload mode="basic" @select="onFileSelect" customUpload auto :choose-button-props="{ label: '', text: true }">
                    <template #chooseicon>
                        <Icon icon="mdi:upload" class="w-5 h-5" />
                    </template>
                </FileUpload>

                <Button size="small" :text="!isTrackSettingsExpanded" @click="toggleTrackSettings">
                    <Icon icon="akar-icons:settings-vertical" class="w-5 h-5" />
                </Button>
                <Button size="small" :text="selectedTrack?.id !== track.id" @click="selectCurrentTrack">
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
                                'tick--selected': selectedTrack?.id === track.id,
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

        <div v-if="track.sampleName" class="text-sm text-center text-surface-400">
            <SamplerTrackWaveform :track="track" />
        </div>
    </div>
</template>
