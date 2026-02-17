import { engine } from '@/juicyloops/engine';
import { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { ref, watch } from 'vue';

const bpm = ref(136);
const tracks = ref<BaseTrack[]>([]);
const currentTick = ref(0);

export const useJuicyLoops = () => {
    watch(bpm, (newBPM) => {
        engine.setBPM(newBPM);
    });

    const addSynth = async (): Promise<SynthTrack | null> => {
        const synth = await engine.addTrack('synth') as SynthTrack;

        if (!synth) {
            return null;
        }

        tracks.value.push(synth);

        return synth;
    };

    const addSampler = async () => {
        const sampler = await engine.addTrack('sampler');

        if (!sampler) {
            return null;
        }

        tracks.value.push(sampler);

        return sampler;
    };

    const addMicrophone = async () => {
        const microphone = await engine.addTrack('microphone');

        if (!microphone) {
            return null;
        }

        tracks.value.push(microphone);

        return microphone;
    };

    const removeTrack = async (id: string) => {
        await engine.removeTrack(id);
        tracks.value = tracks.value.filter((track) => track.id !== id);
    };

    const duplicateTrack = async (id: string) => {
        const trackToDuplicate = tracks.value.find((track) => track.id === id);
        if (!trackToDuplicate) {
            return;
        }

        if(trackToDuplicate instanceof SynthTrack) {
            const newTrack = await engine.addTrack('synth') as SynthTrack;
            if(!newTrack) {
                return;
            }

            newTrack.synth.oscillator.type = trackToDuplicate.synth.oscillator.type;
            newTrack.ticks = trackToDuplicate.ticks.map(tick => JSON.parse(JSON.stringify(tick)));

            tracks.value.push(newTrack);
        }
    }

    return {
        bpm,
        engine,
        tracks,
        currentTick,
        addSynth,
        addSampler,
        addMicrophone,
        removeTrack,
        duplicateTrack,
    };
};
