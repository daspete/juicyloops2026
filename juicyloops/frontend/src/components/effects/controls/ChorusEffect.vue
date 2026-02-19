<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Knob } from 'primevue';
import { computed } from 'vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const wetValue = computed({
    get: () => props.track.effects.chorus.wet.value as number,
    set: (value: number) => {
        props.track.effects.setChorus({
            wet: value,
        });
    },
});

const frequencyValue = computed({
    get: () => props.track.effects.chorus.frequency.value as number,
    set: (value: number) => {
        props.track.effects.setChorus({
            frequency: value,
        });
    },
});

const depthValue = computed({
    get: () => props.track.effects.chorus.depth,
    set: (value: number) => {
        props.track.effects.setChorus({
            depth: value,
        });
    },
});

const delayTimeValue = computed({
    get: () => props.track.effects.chorus.delayTime,
    set: (value: number) => {
        props.track.effects.setChorus({
            delayTime: value,
        });
    },
});
</script>

<template>
    <div class="rounded p-2 bg-surface-800 w-72 flex flex-col gap-2">
        <div class="font-semibold">Chorus</div>
        <div class="grid grid-cols-4 gap-2">
            <div class="flex flex-col items-center">
                <Knob v-model="wetValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Wet</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="frequencyValue" :min="0.1" :max="8" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Frequency</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="depthValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Depth</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="delayTimeValue" :min="0" :max="10" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Delay Time</div>
            </div>
        </div>
    </div>
</template>
