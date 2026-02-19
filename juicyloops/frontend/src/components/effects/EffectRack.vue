<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import AutoFilterEffect from './controls/AutoFilterEffect.vue';
import BitCrusherEffect from './controls/BitCrusherEffect.vue';
import ChorusEffect from './controls/ChorusEffect.vue';
import CompressorEffect from './controls/CompressorEffect.vue';
import DelayEffect from './controls/DelayEffect.vue';
import ReverbEffect from './controls/ReverbEffect.vue';
import DistortionEffect from './controls/DistortionEffect.vue';
import EqualizerEffect from './controls/EqualizerEffect.vue';
import LimiterEffect from './controls/LimiterEffect.vue';
import PhaserEffect from './controls/PhaserEffect.vue';
import TremoloEffect from './controls/TremoloEffect.vue';
import VibratoEffect from './controls/VibratoEffect.vue';

const props = defineProps<{
    track: BaseTrack;
}>();

</script>

<template>
    <div class="flex gap-2">
        <div class="w-8">b</div>
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
