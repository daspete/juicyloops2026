<script setup lang="ts">
import { Button, ButtonGroup, Drawer, InputNumber } from 'primevue';
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import JuicySynthTrack from './tracks/JuicySynthTrack.vue';
import JuicySamplerTrack from './tracks/JuicySamplerTrack.vue';
import JuicyMicrophoneTrack from './tracks/JuicyMicrophoneTrack.vue';
import GiscusLoader from './GiscusLoader.vue';

const { engine, bpm, tracks, addSynth, addSampler, addMicrophone } = useJuicyLoops();

const isInitialized = ref(false);
const isDiscussionsOpen = ref(false);

const initializeEngine = async () => {
    await engine.initialize();
    isInitialized.value = true;
};
</script>

<template>
    <div class="flex flex-col gap-2 w-full min-h-dvh">
        <div class="flex flex-wrap sm:flex-nowrap items-center gap-2 w-full px-3 sm:px-4 py-2 bg-black">
            <div class="w-36 sm:w-48 shrink-0">
                <img src="/juicyloopslogo.svg" />
            </div>
            <div class="order-3 sm:order-none w-full sm:w-auto flex-1 flex items-center gap-2 justify-between sm:justify-center">
                <div class="w-full sm:w-30 max-w-48">
                    <InputNumber v-model="bpm" :min="10" :max="900" show-buttons placeholder="Tempo" suffix=" BPM" fluid />
                </div>
                <ButtonGroup>
                    <Button @click="engine.play()" class="touch-target">
                        <Icon icon="material-symbols:play-arrow" class="w-5 h-5" />
                    </Button>
                    <Button @click="engine.stop()" class="touch-target">
                        <Icon icon="material-symbols:stop" class="w-5 h-5" />
                    </Button>
                </ButtonGroup>
            </div>
            <div class="ml-auto sm:ml-0">
                <Button text @click="isDiscussionsOpen = true" class="touch-target">
                    <Icon icon="ph:chats" class="w-5 h-5" />
                </Button>
            </div>
        </div>

        <div class="overflow-hidden px-2 sm:px-4 rounded flex-1 min-h-0">
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

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 p-3 sm:p-6 rounded bg-surface-900 mx-2 sm:mx-4">
            <Button severity="info" @click="addSynth">
                <div class="flex flex-col gap-2 justify-center items-center w-full sm:w-42">
                    <Icon icon="qlementine-icons:synthesizer-16" class="w-10 h-10" />
                    <div class="font-semibold">New Synth track</div>
                </div>
            </Button>

            <Button severity="info" @click="addSampler">
                <div class="flex flex-col gap-2 justify-center items-center w-full sm:w-42">
                    <Icon icon="mdi:waveform" class="w-10 h-10" />
                    <div class="font-semibold">New Sampler track</div>
                </div>
            </Button>

            <!-- <Button label="Add Drum computer track" severity="info" @click="addSynth" /> -->
            <Button severity="info" @click="addMicrophone">
                <div class="flex flex-col gap-2 justify-center items-center w-full sm:w-42">
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

    <Drawer v-model:visible="isDiscussionsOpen" header="Discussions" position="right" class="max-w-full w-120">
        <GiscusLoader />
    </Drawer>
</template>
