<script setup lang="ts">
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { Button } from 'primevue';

const props = defineProps<{
    track: SynthTrack;
}>();
</script>

<template>
    <div v-if="props.track" class="flex items-center gap-1">
        <div class="flex items-center gap-1 rounded bg-surface-800">
            <Button size="small" :text="props.track.synth.oscillator.type !== 'sine'" @click="props.track.setSynthType('sine')" title="Sine wave oscillator">
                <Icon icon="mdi:sine-wave" class="w-6 h-6" />
            </Button>
            <Button size="small" :text="props.track.synth.oscillator.type !== 'square'" @click="props.track.setSynthType('square')" title="Square wave oscillator">
                <Icon icon="mdi:square-wave" class="w-6 h-6" />
            </Button>
            <Button size="small" :text="props.track.synth.oscillator.type !== 'triangle'" @click="props.track.setSynthType('triangle')" title="Triangle wave oscillator">
                <Icon icon="mdi:triangle-wave" class="w-6 h-6" />
            </Button>
            <Button size="small" :text="props.track.synth.oscillator.type !== 'sawtooth'" @click="props.track.setSynthType('sawtooth')" title="Sawtooth wave oscillator">
                <Icon icon="mdi:sawtooth-wave" class="w-6 h-6" />
            </Button>
        </div>
    </div>
</template>
