<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Knob } from 'primevue';
import { computed } from 'vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const wetValue = computed({
    get: () => props.track.effects.distortion.wet.value as number,
    set: (value: number) => {
        props.track.effects.setDistortion({
            wet: value,
        });
    },
});

const distortionValue = computed({
    get: () => props.track.effects.distortion.distortion as number,
    set: (value: number) => {
        props.track.effects.setDistortion({
            distortion: value,
        });
    },
});
</script>

<template>
    <div class="rounded p-2 bg-surface-800 w-36 flex flex-col gap-2">
        <div class="font-semibold">Distortion</div>
        <div class="grid grid-cols-2 gap-2">
            <div class="flex flex-col items-center">
                <Knob v-model="wetValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Wet</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="distortionValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Distortion</div>
            </div>
        </div>
    </div>
</template>
