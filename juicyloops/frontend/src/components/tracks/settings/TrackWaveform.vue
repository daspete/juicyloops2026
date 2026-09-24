<script setup lang="ts">
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import { onMounted, onUnmounted, useTemplateRef, watch } from 'vue';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.js';

/**
 * Shows the loaded sample, the region that is played and the cuts that slice it.
 * Drag or resize the region to trim; double-click inside it to cut, drag a cut to move it, double-click a cut to remove it.
 */
const props = defineProps<{
    track: SampleTrack;
}>();

const container = useTemplateRef<HTMLDivElement>('container');

let waveSurfer: WaveSurfer | null = null;
let regions: RegionsPlugin | null = null;
let trim: Region | null = null;
let markers: Region[] = [];
let accent = '#ff8a2a';

/** The slice number a cut starts, or null for a cut outside the region (it is kept, but plays no part). */
const sliceNumber = (cut: number): number | null => {
    const index = props.track.slices.findIndex((slice) => slice.start === cut);
    return index > 0 ? index + 1 : null;
};

const markerLabel = (number: number | null): HTMLElement => {
    // Regions live in the waveform's shadow DOM, out of reach of the stylesheet.
    const label = document.createElement('span');
    label.textContent = number === null ? '' : String(number);
    Object.assign(label.style, { display: number === null ? 'none' : 'inline-block', padding: '0 4px', font: '600 10px/14px var(--font-mono, monospace)', color: 'var(--jl-text, #fff)', background: accent, borderRadius: '0 4px 4px 0' });
    return label;
};

/** Puts the region and the cuts on the waveform where the track has them. */
const sync = () => {
    if (!regions) {
        return;
    }
    const start = props.track.sampleStartTime;
    const end = start + props.track.sampleDuration;
    if (!trim) {
        trim = regions.addRegion({ start, end, color: `color-mix(in oklab, ${accent} 24%, transparent)`, drag: true, resize: true });
    } else if (Math.abs(trim.start - start) > 1e-6 || Math.abs(trim.end - end) > 1e-6) {
        trim.setOptions({ start, end });
    }

    markers.forEach((marker) => marker.remove());
    markers = props.track.cuts.map((cut) => {
        const number = sliceNumber(cut);
        return regions!.addRegion({ start: cut, color: number === null ? 'var(--jl-muted)' : accent, drag: true, resize: false, content: markerLabel(number) });
    });
};

const onRegionUpdated = (region: Region, side?: 'start' | 'end') => {
    if (region === trim) {
        const oldStart = props.track.sampleStartTime;
        const oldEnd = oldStart + props.track.sampleDuration;
        props.track.setSampleTimes(region.start, region.end - region.start);
        // Moving the whole region takes its cuts along, so the slices stay the same parts of the sound.
        if (!side && props.track.cuts.length) {
            const delta = region.start - oldStart;
            props.track.setCuts(props.track.cuts.map((cut) => (cut > oldStart && cut < oldEnd ? cut + delta : cut)));
        }
    } else if (markers.includes(region)) {
        props.track.setCuts(markers.map((marker) => marker.start));
    }
    sync();
};

const onRegionDoubleClicked = (region: Region, event: MouseEvent) => {
    const index = markers.indexOf(region);
    if (index >= 0) {
        // Keep the double-click from reaching the waveform, which would cut right here again.
        event.stopPropagation();
        props.track.setCuts(markers.filter((_, i) => i !== index).map((marker) => marker.start));
    }
};

/** Double-click inside the region cuts it there. */
const onDoubleClick = (event: MouseEvent) => {
    if (!waveSurfer) {
        return;
    }
    const rect = waveSurfer.getWrapper().getBoundingClientRect();
    const time = ((event.clientX - rect.left) / rect.width) * waveSurfer.getDuration();
    const start = props.track.sampleStartTime;
    if (time > start && time < start + props.track.sampleDuration) {
        props.track.addCut(time);
    }
};

onMounted(() => {
    if (!container.value || !props.track.sampleBlob) {
        return;
    }

    const style = getComputedStyle(container.value);
    accent = style.getPropertyValue('--jl-accent').trim() || accent;
    const wave = style.getPropertyValue('--jl-bar').trim() || '#8b84b0';
    regions = RegionsPlugin.create();

    waveSurfer = WaveSurfer.create({
        container: container.value,
        plugins: [regions],
        height: 88,
        waveColor: wave,
        progressColor: wave,
        cursorWidth: 0,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
    });

    waveSurfer.on('ready', () => {
        sync();
        regions!.on('region-updated', onRegionUpdated);
        regions!.on('region-double-clicked', onRegionDoubleClicked);
    });

    waveSurfer.loadBlob(props.track.sampleBlob);
});

/* Cuts made elsewhere (the slice buttons, undo) show up right away. */
watch(() => JSON.stringify([props.track.sampleStartTime, props.track.sampleDuration, props.track.cuts]), sync);

onUnmounted(() => {
    waveSurfer?.destroy();
    waveSurfer = null;
    regions = null;
    trim = null;
    markers = [];
});
</script>

<template>
    <div ref="container" class="waveform rounded-lg bg-(--jl-cell) px-1" @dblclick="onDoubleClick"></div>
</template>
