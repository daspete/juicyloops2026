<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Knob } from 'primevue';
import { computed } from 'vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const thresholdValue = computed({
    get: () => props.track.effects.compressor.threshold.value as number,
    set: (value: number) => {
        props.track.effects.setCompressor({
            threshold: value,
        });
    },
});

const ratioValue = computed({
    get: () => props.track.effects.compressor.ratio.value as number,
    set: (value: number) => {
        props.track.effects.setCompressor({
            ratio: value,
        });
    },
});

const attackValue = computed({
    get: () => props.track.effects.compressor.attack.value as number,
    set: (value: number) => {
        props.track.effects.setCompressor({
            attack: value,
        });
    },
});

const releaseValue = computed({
    get: () => props.track.effects.compressor.release.value as number,
    set: (value: number) => {
        props.track.effects.setCompressor({
            release: value,
        });
    },
});
</script>

<template>
    <div class="rounded p-2 bg-surface-800 w-72 flex flex-col gap-2">
        <div class="font-semibold">Compressor</div>
        <div class="grid grid-cols-4 gap-2">
            <div class="flex flex-col items-center">
                <Knob v-model="thresholdValue" :min="-100" :max="0" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Threshold</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="ratioValue" :min="1" :max="20" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Ratio</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="attackValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Attack</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="releaseValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Release</div>
            </div>
        </div>
    </div>
</template>
