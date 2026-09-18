<script setup lang="ts">
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import { onMounted, onUnmounted, useTemplateRef } from 'vue';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';

/** Shows the loaded sample and lets the user drag/resize the region that is played. */
const props = defineProps<{
    track: SampleTrack;
}>();

const container = useTemplateRef<HTMLDivElement>('container');

let waveSurfer: WaveSurfer | null = null;

onMounted(() => {
    if (!container.value || !props.track.sampleBlob) {
        return;
    }

    const accent = getComputedStyle(container.value).getPropertyValue('--jl-accent').trim() || '#ff8a2a';
    const regions = RegionsPlugin.create();

    waveSurfer = WaveSurfer.create({
        container: container.value,
        plugins: [regions],
        height: 88,
        waveColor: '#bdb0a5',
        progressColor: '#bdb0a5',
        cursorWidth: 0,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
    });

    waveSurfer.on('ready', () => {
        regions.addRegion({
            start: props.track.sampleStartTime,
            end: props.track.sampleStartTime + props.track.sampleDuration,
            color: `color-mix(in oklab, ${accent} 16%, transparent)`,
            drag: true,
            resize: true,
        });

        regions.on('region-updated', (region) => {
            props.track.setSampleTimes(region.start, region.end - region.start);
        });
    });

    waveSurfer.loadBlob(props.track.sampleBlob);
});

onUnmounted(() => {
    waveSurfer?.destroy();
    waveSurfer = null;
});
</script>

<template>
    <div ref="container" class="rounded-lg bg-(--jl-cell) px-1" :class="{ 'waveform--reversed': props.track.isReversed }"></div>
</template>
