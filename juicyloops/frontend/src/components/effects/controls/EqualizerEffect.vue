<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Knob } from 'primevue';
import { computed } from 'vue';

const props = defineProps<{
    track: BaseTrack;
}>();
const lowValue = computed({
    get: () => props.track.effects.equalizer.low.value as number,
    set: (value: number) => {
        props.track.effects.setEqualizer({
            low: value,
        });
    },
});

const midValue = computed({
    get: () => props.track.effects.equalizer.mid.value as number,
    set: (value: number) => {
        props.track.effects.setEqualizer({
            mid: value,
        });
    },
});

const highValue = computed({
    get: () => props.track.effects.equalizer.high.value as number,
    set: (value: number) => {
        props.track.effects.setEqualizer({
            high: value,
        });
    },
});
</script>

<template>
    <div class="rounded p-2 bg-surface-800 w-52 flex flex-col gap-2">
        <div class="font-semibold">Equalizer</div>
        <div class="grid grid-cols-3 gap-2">
            <div class="flex flex-col items-center">
                <Knob v-model="lowValue" :min="-12" :max="12" :step="0.1" :size="50" :value-template="(value) => `${Math.round(value * 10) / 10}`" />
                <div class="text-xs">Low</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="midValue" :min="-12" :max="12" :step="0.1" :size="50" :value-template="(value) => `${Math.round(value * 10) / 10}`" />
                <div class="text-xs">Mid</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="highValue" :min="-12" :max="12" :step="0.1" :size="50" :value-template="(value) => `${Math.round(value * 10) / 10}`" />
                <div class="text-xs">High</div>
            </div>
        </div>
    </div>
</template>
