<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import type { SamplerTickSettings, SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { Icon } from '@iconify/vue';
import { Button, FileUpload, type FileUploadSelectEvent } from 'primevue';
import { onMounted, ref } from 'vue';

const { tracks, removeTrack, selectedTrack } = useJuicyLoops();

const props = defineProps<{
    trackId: string;
}>();

const track = ref<SamplerTrack>(tracks.value.find((t) => t.id === props.trackId) as SamplerTrack);

onMounted(async () => {});

const updateTick = (tick: SamplerTickSettings) => {
    tick.isActive = !tick.isActive;
}

const deleteTrack = () => {
    removeTrack(track.value.id);
};

const onFileSelect = async (event: FileUploadSelectEvent) => {
    const file = Array.isArray(event.files) ? event.files[0] : event.files;

    if (!file) {
        return;
    }

    const fileReader = new FileReader();
    fileReader.onload = async (e) => {
        const result = e.target?.result;
        if(!result) {
            return;
        }
        track.value.setSampleFromArrayBuffer(result as ArrayBuffer);
        track.value.setSampleName(file.name);
    }
    fileReader.readAsArrayBuffer(file);
};

const selectCurrentTrack = () => {
    selectedTrack.value = track.value as unknown as BaseTrack;
}
</script>

<template>
    <div class="rounded pl-2 pr-6 py-2 bg-surface-800 flex flex-col gap-4">
        <div class="flex gap-2 items-center">
            <div class="w-24 font-semibold" @click="selectCurrentTrack">Sampler</div>
            <div class="flex-1 flex items-center gap-4">
                <div class="flex items-center gap-1 rounded bg-surface-700">
                    <FileUpload mode="basic" @select="onFileSelect" choose-label="Select sample" customUpload auto severity="secondary" />
                    <div class="px-2" v-if="track.sampleName">
                        {{ track.sampleName }}
                    </div>
                </div>

                <Button size="small" text @click="deleteTrack">
                    <Icon icon="mdi:trash" class="w-6 h-6" />
                </Button>
            </div>
        </div>

        <div class="flex gap-2">
            <div class="w-24"></div>
            <div class="flex-1 flex flex-col gap-4">
                <div class="w-full grid grid-cols-32 gap-1">
                    <div v-for="(tick, tickIndex) in track.ticks" :key="tickIndex">
                        <div
                            class="w-full h-8 rounded flex items-center justify-center cursor-pointer shadow"
                            :class="tick.isActive ? 'bg-orange-500  shadow-orange-700' : 'bg-surface-600'"
                            @click="updateTick(tick)"
                        >

                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
