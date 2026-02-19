<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Knob } from 'primevue';
import { computed } from 'vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const wetValue = computed({
    get: () => props.track.effects.phaser.wet.value as number,
    set: (value: number) => {
        props.track.effects.setPhaser({
            wet: value,
        });
    },
});

const frequencyValue = computed({
    get: () => props.track.effects.phaser.frequency.value as number,
    set: (value: number) => {
        props.track.effects.setPhaser({
            frequency: value,
        });
    },
});

const baseFrequencyValue = computed({
    get: () => props.track.effects.phaser.baseFrequency as number,
    set: (value: number) => {
        props.track.effects.setPhaser({
            baseFrequency: value,
        });
    },
});

const octavesValue = computed({
    get: () => props.track.effects.phaser.octaves as number,
    set: (value: number) => {
        props.track.effects.setPhaser({
            octaves: value,
        });
    },
});
</script>

<template>
    <div class="rounded p-2 bg-surface-800 w-72 flex flex-col gap-2">
        <div class="font-semibold">Phaser</div>
        <div class="grid grid-cols-4 gap-2">
            <div class="flex flex-col items-center">
                <Knob v-model="wetValue" :min="0" :max="1" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Wet</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="frequencyValue" :min="0.1" :max="2" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Frequency</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="baseFrequencyValue" :min="0" :max="1000" :step="0.01" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Base Freq.</div>
            </div>
            <div class="flex flex-col items-center">
                <Knob v-model="octavesValue" :min="1" :max="8" :step="1" :size="50" :value-template="(value) => `${Math.round(value * 100) / 100}`" />
                <div class="text-xs">Octaves</div>
            </div>
        </div>
    </div>
</template>
