<script setup lang="ts">
import type { MixBus } from '@/juicyloops/mixBus';
import { Icon } from '@iconify/vue';
import { ref, watch } from 'vue';
import JuicyKnob from '../ui/JuicyKnob.vue';
import EffectRack from '../effects/EffectRack.vue';

/**
 * One channel strip of the mixer: level and pan up top, the effect rack stacked below.
 * The bus is not reactive (it owns Tone nodes), so the knobs keep their own values and write them through.
 */
const props = defineProps<{
    bus: MixBus;
    name: string;
    kind: string;
    icon: string;
    note: string;
    accent: string;
}>();

const volume = ref(props.bus.volume);
const pan = ref(props.bus.pan);

watch(volume, (value) => props.bus.setVolume(value));
watch(pan, (value) => props.bus.setPan(value));

const formatDecibel = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
const formatPan = (value: number) => (Math.abs(value) < 0.005 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`);
</script>

<template>
    <section class="strip" :style="{ '--jl-accent': props.accent }" :aria-label="props.name">
        <header class="strip-head">
            <span class="track-badge"><Icon :icon="props.icon" class="w-4 h-4" /></span>
            <div class="strip-title">
                <span class="eyebrow">{{ props.kind }}</span>
                <span class="strip-name">{{ props.name }}</span>
            </div>
        </header>
        <p class="strip-note">{{ props.note }}</p>
        <div class="strip-level">
            <JuicyKnob v-model="volume" :min="-40" :max="6" :step="0.1" label="Level" :reset-value="0" :format="formatDecibel" :size="64" />
            <JuicyKnob v-model="pan" :min="-1" :max="1" :step="0.01" label="Pan" :reset-value="0" :format="formatPan" :size="64" />
        </div>
        <div class="strip-rack">
            <span class="eyebrow">Effects</span>
            <EffectRack :effects="props.bus.effects" compact />
        </div>
    </section>
</template>
