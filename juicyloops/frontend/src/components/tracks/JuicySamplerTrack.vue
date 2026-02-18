<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { Icon } from '@iconify/vue';
import { Button, Popover } from 'primevue';
import { computed, ref } from 'vue';
import TrackWaveform from './settings/TrackWaveform.vue';
import type { SamplerTick } from '@/juicyloops/ticks/SamplerTick';
import TrackVolumeSettings from './settings/TrackVolumeSettings.vue';
import TrackPatternSettings from './settings/TrackPatternSettings.vue';
import SamplerFileUpload from './settings/SamplerFileUpload.vue';

const { tracks, removeTrack, currentTick, duplicateTrack } = useJuicyLoops();

const props = defineProps<{
    trackId: string;
    trackIndex: number;
}>();

const track = computed<SamplerTrack>(() => tracks.value.find((t) => t.id === props.trackId) as SamplerTrack);

const isVolumeSettingsExpanded = ref(false);
const isWaveformExpanded = ref(false);
const settingsPopover = ref();

const updateTick = (tick: SamplerTick) => {
    tick.isActive = !tick.isActive;
};

const showSettings = (event: any) => {
    settingsPopover.value.toggle(event);
};

const onSampleUploaded = () => {
    isWaveformExpanded.value = true;
}
</script>

<template>
    <div class="pl-2 py-1 pr-6 flex flex-col gap-4 track">
        <div class="flex gap-2 items-start">
            <div class="font-semibold flex h-9 rounded px-2 items-center gap-2">
                <Icon icon="mdi:waveform" class="w-5 h-5" />
                <div class="text-xs w-6 text-right">#{{ props.trackIndex + 1 }}</div>
            </div>
            <div class="flex items-center gap-1 rounded bg-surface-800 w-49 h-9">
                <Button size="small" :disabled="!track.sampleName" :text="!isWaveformExpanded" @click="isWaveformExpanded = !isWaveformExpanded">
                    <Icon icon="mdi:waveform" class="w-5 h-5" />
                </Button>
                <Button size="small" :text="!isVolumeSettingsExpanded" @click="isVolumeSettingsExpanded = !isVolumeSettingsExpanded">
                    <Icon icon="akar-icons:settings-vertical" class="w-5 h-5" />
                </Button>
                <Button size="small" text @click="showSettings">
                    <Icon icon="ic:baseline-settings" class="w-5 h-5" />
                </Button>
                <Button size="small" text @click="duplicateTrack(track.id)">
                    <Icon icon="mdi:content-copy" class="w-5 h-5" />
                </Button>
                <Button size="small" text @click="removeTrack(track.id)">
                    <Icon icon="mdi:trash" class="w-5 h-5" />
                </Button>
            </div>

            <div class="flex-1 flex flex-col gap-2">
                <div class="w-full grid grid-cols-32 gap-1 justify-stretch items-stretch h-9" v-if="track.sampleName">
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

                <div v-if="!track.sampleName">
                    <SamplerFileUpload :track="track" @uploaded="onSampleUploaded" />
                </div>

                <TrackVolumeSettings :track="track" v-if="isVolumeSettingsExpanded" />

                <div v-if="track.sampleName && !track.isUpdatingSample && isWaveformExpanded" class="flex flex-col gap-1">
                    <SamplerFileUpload :track="track" label="Change current sample" />
                    <TrackWaveform :track="track" />
                </div>
            </div>
        </div>

        <Popover ref="settingsPopover">
            <div class="flex items-center gap-1">
                <TrackPatternSettings :track="track" />
            </div>
        </Popover>
    </div>
</template>
