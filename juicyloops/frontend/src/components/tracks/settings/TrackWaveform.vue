<script setup lang="ts">
import { MicrophoneTrack } from '@/juicyloops/tracks/MicrophoneTrack';
import { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { onMounted, ref } from 'vue';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';

const props = defineProps<{
    track: SamplerTrack | MicrophoneTrack;
}>();

const waveSurfer = ref<WaveSurfer | null>(null);

onMounted(async () => {
    const regionsPlugin = RegionsPlugin.create();

    waveSurfer.value = WaveSurfer.create({
        container: `#waveform-${props.track.id}`,
        plugins: [regionsPlugin],
        height: 100,
    });

    if (props.track instanceof SamplerTrack) {
        waveSurfer.value.loadBlob(props.track.file!);
    }

    if (props.track instanceof MicrophoneTrack && props.track.hasRecordedAudio) {
        waveSurfer.value.loadBlob(props.track.recordedAudio!);
    }

    waveSurfer.value.on('ready', () => {
        if (!waveSurfer.value) return;

        regionsPlugin.addRegion({
            start: props.track.sampleStartTime,
            end: props.track.sampleStartTime + props.track.sampleDuration,
            color: 'rgba(255, 127, 0, 0.3)',
            drag: true,
            resize: true,
        });

        regionsPlugin.on('region-updated', (region) => {
            props.track.setSampleTimes(region.start, region.end - region.start);
        });
    });
});
</script>

<template>
    <div v-if="props.track.id">
        <div :id="`waveform-${props.track.id}`" :class="{'waveform--reversed': props.track.isReversed}"></div>
    </div>
</template>
