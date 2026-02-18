import { engine } from '@/juicyloops/engine';
import { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { MicrophoneTrack } from '@/juicyloops/tracks/MicrophoneTrack';
import { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { sleep } from '@/juicyloops/utils/sleep';
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

        if(trackToDuplicate instanceof SamplerTrack) {
            const newTrack = await engine.addTrack('sampler') as SamplerTrack;
            if(!newTrack) {
                return;
            }

            newTrack.ticks = trackToDuplicate.ticks.map(tick => JSON.parse(JSON.stringify(tick)));
            newTrack.sampleName = trackToDuplicate.sampleName;

            if(trackToDuplicate.file) {
                await newTrack.setFile(trackToDuplicate.file);
            }

            await sleep(10);

            newTrack.sampleStartTime = trackToDuplicate.sampleStartTime;
            newTrack.sampleDuration = trackToDuplicate.sampleDuration;

            tracks.value.push(newTrack);
        }

        if(trackToDuplicate instanceof MicrophoneTrack) {
            const newTrack = await engine.addTrack('microphone') as MicrophoneTrack;
            if(!newTrack) {
                return;
            }

            newTrack.ticks = trackToDuplicate.ticks.map(tick => JSON.parse(JSON.stringify(tick)));
            newTrack.sampleName = trackToDuplicate.sampleName;

            if(trackToDuplicate.recordedAudio) {
                newTrack.recordedAudio = trackToDuplicate.recordedAudio;
                newTrack.recordedAudioObject = trackToDuplicate.recordedAudioObject;
                await newTrack.player.load(newTrack.recordedAudioObject!);
                newTrack.hasRecordedAudio = true;
                newTrack.isRecording = false;
            }

            await sleep(10);

            newTrack.sampleStartTime = trackToDuplicate.sampleStartTime;
            newTrack.sampleDuration = trackToDuplicate.sampleDuration;

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
