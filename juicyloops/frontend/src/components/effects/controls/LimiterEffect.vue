<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Knob } from 'primevue';
import { computed } from 'vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const thresholdValue = computed({
    get: () => props.track.effects.limiter.threshold.value as number,
    set: (value: number) => {
        props.track.effects.setLimiter(value);
    },
});
</script>

<template>
    <div class="rounded p-2 bg-surface-800 w-18 flex flex-col gap-2">
        <div class="font-semibold">Limiter</div>
        <div class="grid grid-cols-1 gap-2">
            <div class="flex flex-col items-center">
                <Knob v-model="thresholdValue" :min="-50" :max="0" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Threshold</div>
            </div>
        </div>
    </div>
</template>
