<script setup lang="ts">
import { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { onMounted, ref } from 'vue';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';

const props = defineProps<{
    track: SamplerTrack;
}>();

const waveSurfer = ref<WaveSurfer | null>(null);

onMounted(() => {
    const regionsPlugin = RegionsPlugin.create();

    waveSurfer.value = WaveSurfer.create({
        container: `#waveform-${props.track.id}`,
        plugins: [
            regionsPlugin,
        ],
        waveColor: '#555',
        progressColor: '#999',
        height: 80,
    });

    waveSurfer.value.loadBlob(props.track.file!);
    waveSurfer.value.on('ready', () => {
        if (!waveSurfer.value) return;

        const duration = waveSurfer.value.getDuration();
        props.track.setSampleTimes(0, duration);

        regionsPlugin.addRegion({
            start: props.track.sampleStartTime,
            end: props.track.sampleEndTime,
            color: 'rgba(255, 255, 255, 0.3)',
            drag: true,
            resize: true,
        });

        regionsPlugin.on('region-updated', (region) => {
            props.track.setSampleTimes(region.start, region.end - region.start);
        });
    });
})

</script>

<template>
    <div v-if="props.track.id">
        <div :id="`waveform-${props.track.id}`"></div>
    </div>
</template>
