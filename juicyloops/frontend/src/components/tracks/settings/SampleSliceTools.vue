<script setup lang="ts">
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import { Icon } from '@iconify/vue';
import { computed, ref } from 'vue';

/** Ways to cut the played region into slices: at the hits, into equal parts, or not at all. */
const props = defineProps<{
    track: SampleTrack;
}>();

const EVEN_COUNTS = [4, 8, 16] as const;

const count = computed(() => props.track.slices.length);

/** The hit search runs in the sample worker; the button waits for it instead of being pressed twice. */
const isFindingHits = ref(false);

const sliceAtHits = async () => {
    isFindingHits.value = true;
    try {
        await props.track.sliceAtHits();
    } catch (error) {
        console.warn('Could not find the hits', error);
    } finally {
        isFindingHits.value = false;
    }
};
</script>

<template>
    <div class="lane-foot">
        <span class="setting-label">Slices</span>
        <button
            type="button"
            class="chip"
            :disabled="isFindingHits"
            :aria-busy="isFindingHits"
            v-tooltip.bottom="'Cut wherever a hit or note starts'"
            @click="sliceAtHits"
        >
            <Icon :icon="isFindingHits ? 'mdi:loading' : 'mdi:content-cut'" class="w-4 h-4" :class="{ 'animate-spin': isFindingHits }" />
            <span>At hits</span>
        </button>
        <button
            v-for="parts in EVEN_COUNTS"
            :key="parts"
            type="button"
            class="chip font-mono"
            :data-active="count === parts"
            v-tooltip.bottom="`Cut into ${parts} equal slices`"
            @click="props.track.sliceEvenly(parts)"
        >
            {{ parts }}
        </button>
        <button type="button" class="chip" :disabled="!props.track.cuts.length" v-tooltip.bottom="'Remove every cut'" @click="props.track.clearCuts()">
            <Icon icon="mdi:close" class="w-4 h-4" />
            <span>Clear</span>
        </button>
        <span class="lane-hint">
            {{ count > 1 ? `${count} slices, one per row in Notes.` : 'Not sliced.' }}
            Double-click inside the region to cut, drag a cut to move it, double-click it to remove it.
        </span>
    </div>
</template>
