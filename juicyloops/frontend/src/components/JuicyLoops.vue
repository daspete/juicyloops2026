<script setup lang="ts">
import { Button, InputNumber } from 'primevue';
import { onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import JuicySynthTrack from './tracks/JuicySynthTrack.vue';
import JuicySamplerTrack from './tracks/JuicySamplerTrack.vue';
import SynthTrackDetails from './trackdetails/SynthTrackDetails.vue';
import SamplerTrackDetails from './trackdetails/SamplerTrackDetails.vue';

const { engine, bpm, tracks, selectedTrack, addSynth, addSampler } = useJuicyLoops();

onMounted(async () => {});

const initializeEngine = async () => {
    await engine.initialize();
};
</script>

<template>
    <div class="flex flex-col gap-4 w-full h-full">
        <div class="flex items-center w-full px-4 py-2 bg-surface-950">
            <div class="w-48">
                <img src="/juicyloopslogo.svg" />
            </div>
            <div class="flex-1 flex items-center gap-4 justify-center">
                <div class="w-32">
                    <InputNumber v-model="bpm" show-buttons placeholder="Tempo" suffix=" BPM" fluid />
                </div>
                <Button @click="initializeEngine">
                    <Icon icon="ph:play-bold" class="w-6 h-6" />
                </Button>
            </div>
        </div>

        <div class="overflow-hidden px-4 rounded">
            <div class="flex max-h-full overflow-hidden ">
                <div class="flex-1 flex flex-col overflow-auto">
                    <div v-for="(track, trackIndex) in tracks" :key="trackIndex">
                        <JuicySynthTrack v-if="track.type === 'synth'" :trackId="track.id" />
                        <JuicySamplerTrack v-if="track.type === 'sampler'" :trackId="track.id" />
                    </div>
                </div>
                <div class="w-128 bg-surface-800 px-4 py-2 rounded-r rounded-bl-md" id="trackdetails" v-show="!!selectedTrack">
                    <SynthTrackDetails v-if="selectedTrack?.type === 'synth'" />
                    <SamplerTrackDetails v-if="selectedTrack?.type === 'sampler'" />
                </div>
            </div>
        </div>


        <div class="flex items-center gap-2 justify-center p-8 rounded bg-surface-800 mx-4">
            <Button label="Add Synth track" severity="info" @click="addSynth" />
            <Button label="Add Sampler track" severity="info" @click="addSampler" />
            <Button label="Add Drum computer track" severity="info" @click="addSynth" />
            <Button label="Add Microphone track" severity="info" @click="addSynth" />

        </div>

    </div>
</template>
