import { engine } from '@/juicyloops/engine';
import { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { ref, watch } from 'vue';

const bpm = ref(136);
const tracks = ref<BaseTrack[]>([]);
const selectedTrack = ref<BaseTrack>();
const currentTick = ref(0);

export const useJuicyLoops = () => {
    watch(bpm, (newBPM) => {
        engine.setBPM(newBPM);
    });

    const addSynth = async () => {
        const synth = await engine.addTrack('synth');

        if (!synth) {
            return;
        }

        tracks.value.push(synth);
    };

    const addSampler = async () => {
        const sampler = await engine.addTrack('sampler');

        if (!sampler) {
            return;
        }

        tracks.value.push(sampler);
    };

    const removeTrack = async (id: string) => {
        await engine.removeTrack(id);
        tracks.value = tracks.value.filter((track) => track.id !== id);
    };

    return {
        bpm,
        engine,
        tracks,
        selectedTrack,
        currentTick,
        addSynth,
        addSampler,
        removeTrack,
    };
};
