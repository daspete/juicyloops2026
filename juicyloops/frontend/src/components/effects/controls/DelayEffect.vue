<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Knob } from 'primevue';
import { computed } from 'vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const wetValue = computed({
    get: () => props.track.effects.delay.wet.value,
    set: (value: number) => {
        props.track.effects.setDelay({
            wet: value,
        });
    },
});

const delayTimeValue = computed({
    get: () => props.track.effects.delay.delayTime.value as number,
    set: (value: number) => {
        props.track.effects.setDelay({
            delayTime: value,
        });
    },
});
</script>

<template>
    <div class="rounded p-2 bg-surface-800 w-36 flex flex-col gap-2">
        <div class="font-semibold">Delay</div>
        <div class="grid grid-cols-2 gap-2">
            <div class="flex flex-col items-center">
                <Knob v-model="wetValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Wet</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="delayTimeValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Time</div>
            </div>
        </div>
    </div>
</template>
