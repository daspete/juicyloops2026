<script setup lang="ts">
import type { MixBus } from '@/juicyloops/mixBus';
import { ref, watch } from 'vue';
import JuicyKnob from '../ui/JuicyKnob.vue';
import EffectRack from './EffectRack.vue';

/**
 * The channel strip of a bus (a container or the master): level and pan on the left, the effect rack on the right.
 * The bus is not reactive (it owns Tone nodes), so the knobs keep their own values and write them through.
 */
const props = defineProps<{
    bus: MixBus;
}>();

const volume = ref(props.bus.volume);
const pan = ref(props.bus.pan);

watch(volume, (value) => props.bus.setVolume(value));
watch(pan, (value) => props.bus.setPan(value));

const formatDecibel = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
const formatPan = (value: number) => (Math.abs(value) < 0.005 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`);
</script>

<template>
    <div class="busrack">
        <div class="busrack-level">
            <JuicyKnob v-model="volume" :min="-40" :max="6" :step="0.1" label="Level" :reset-value="0" :format="formatDecibel" :size="60" />
            <JuicyKnob v-model="pan" :min="-1" :max="1" :step="0.01" label="Pan" :reset-value="0" :format="formatPan" :size="60" />
        </div>
        <div class="busrack-effects">
            <EffectRack :effects="props.bus.effects" />
        </div>
    </div>
</template>
