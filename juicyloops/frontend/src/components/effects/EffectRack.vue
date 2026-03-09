<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { defineAsyncComponent } from 'vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const AutoFilterEffect = defineAsyncComponent(() => import('./controls/AutoFilterEffect.vue'));
const BitCrusherEffect = defineAsyncComponent(() => import('./controls/BitCrusherEffect.vue'));
const ChorusEffect = defineAsyncComponent(() => import('./controls/ChorusEffect.vue'));
const CompressorEffect = defineAsyncComponent(() => import('./controls/CompressorEffect.vue'));
const DelayEffect = defineAsyncComponent(() => import('./controls/DelayEffect.vue'));
const ReverbEffect = defineAsyncComponent(() => import('./controls/ReverbEffect.vue'));
const DistortionEffect = defineAsyncComponent(() => import('./controls/DistortionEffect.vue'));
const EqualizerEffect = defineAsyncComponent(() => import('./controls/EqualizerEffect.vue'));
const LimiterEffect = defineAsyncComponent(() => import('./controls/LimiterEffect.vue'));
const PhaserEffect = defineAsyncComponent(() => import('./controls/PhaserEffect.vue'));
const TremoloEffect = defineAsyncComponent(() => import('./controls/TremoloEffect.vue'));
const VibratoEffect = defineAsyncComponent(() => import('./controls/VibratoEffect.vue'));
</script>

<template>
    <div class="flex gap-2">
        <div class="flex flex-wrap gap-2 justify-center">
            <AutoFilterEffect :track="props.track" />
            <BitCrusherEffect :track="props.track" />
            <ChorusEffect :track="props.track" />
            <CompressorEffect :track="props.track" />
            <DelayEffect :track="props.track" />
            <DistortionEffect :track="props.track" />
            <EqualizerEffect :track="props.track" />
            <LimiterEffect :track="props.track" />
            <PhaserEffect :track="props.track" />
            <ReverbEffect :track="props.track" />
            <TremoloEffect :track="props.track" />
            <VibratoEffect :track="props.track" />
        </div>
    </div>
</template>
