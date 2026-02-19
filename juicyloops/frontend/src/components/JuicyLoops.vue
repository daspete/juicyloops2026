<script setup lang="ts">
import { Button, InputNumber } from 'primevue';
import { onMounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import JuicySynthTrack from './tracks/JuicySynthTrack.vue';
import JuicySamplerTrack from './tracks/JuicySamplerTrack.vue';
import JuicyMicrophoneTrack from './tracks/JuicyMicrophoneTrack.vue';

const { engine, bpm, tracks, addSynth, addSampler, addMicrophone } = useJuicyLoops();

onMounted(async () => {});

const isInitialized = ref(false);

const initializeEngine = async () => {
    await engine.initialize();
    isInitialized.value = true;
};
</script>

<template>
    <div class="flex flex-col gap-2 w-full h-full">
        <div class="flex items-center w-full px-4 py-2 bg-black">
            <div class="w-48">
                <img src="/juicyloopslogo.svg" />
            </div>
            <div class="flex-1 flex items-center gap-2 justify-center">
                <div class="w-30">
                    <InputNumber v-model="bpm" :min="10" :max="900" show-buttons placeholder="Tempo" suffix=" BPM" fluid size="small" />
                </div>
                <Button @click="engine.play()" size="small" severity="success">
                    <Icon icon="material-symbols:play-arrow" class="w-6 h-6" />
                </Button>
                <Button @click="engine.stop()" size="small" severity="help">
                    <Icon icon="material-symbols:stop" class="w-6 h-6" />
                </Button>
            </div>
        </div>

        <div class="overflow-hidden px-4 rounded flex-1">
            <div class="flex max-h-full overflow-hidden">
                <div class="flex-1 flex flex-col overflow-auto gap-0.5">
                    <div v-for="(track, trackIndex) in tracks" :key="trackIndex">
                        <JuicySynthTrack v-if="track.type === 'synth'" :trackId="track.id" :trackIndex="trackIndex" />
                        <JuicySamplerTrack v-if="track.type === 'sampler'" :trackId="track.id" :trackIndex="trackIndex" />
                        <JuicyMicrophoneTrack v-if="track.type === 'microphone'" :trackId="track.id" :trackIndex="trackIndex" />
                    </div>
                </div>
            </div>
        </div>

        <div class="flex items-center gap-2 justify-center p-8 rounded bg-surface-900 mx-4">
            <Button severity="info" @click="addSynth">
                <div class="flex flex-col gap-2 justify-center items-center w-42">
                    <Icon icon="qlementine-icons:synthesizer-16" class="w-10 h-10" />
                    <div class="font-semibold">New Synth track</div>
                </div>
            </Button>

            <Button severity="info" @click="addSampler">
                <div class="flex flex-col gap-2 justify-center items-center w-42">
                    <Icon icon="mdi:waveform" class="w-10 h-10" />
                    <div class="font-semibold">New Sampler track</div>
                </div>
            </Button>

            <!-- <Button label="Add Drum computer track" severity="info" @click="addSynth" /> -->
            <Button severity="info" @click="addMicrophone">
                <div class="flex flex-col gap-2 justify-center items-center w-42">
                    <Icon icon="mdi:microphone" class="w-10 h-10" />
                    <div class="font-semibold">New Microphone track</div>
                </div>
            </Button>
        </div>

        <div class="flex justify-center pb-2">
            Made with ❤️ in Vienna by&nbsp;<a href="https://daspete.at" target="_blank" rel="noopener noreferrer" class="text-orange-500">Pete</a>
        </div>
    </div>

    <div v-if="!isInitialized" class="absolute top-0 left-0 w-screen h-screen bg-black/50 z-50 flex items-center justify-center">
        <div class="bg-surface-800 p-8 rounded text-center">
            <p class="mb-4 text-lg">Welcome to JuicyLoops!</p>
            <p class="mb-4">Your step sequencer playground. Happy looping :)</p>
            <Button label="Start the engine" @click="initializeEngine" />
        </div>
    </div>
</template>
