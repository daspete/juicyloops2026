<script setup lang="ts">
import JuicyKnob from '@/components/ui/JuicyKnob.vue';
import { MAX_SAMPLE_SPEED, MIN_SAMPLE_SPEED, SAMPLE_PITCH_RANGE, type SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import { Icon } from '@iconify/vue';

const props = defineProps<{
    track: SampleTrack;
}>();

const LENGTH_MODES = [
    { gate: false, icon: 'mdi:ray-start-arrow', label: 'One-shot', hint: 'Every note plays its slice out' },
    { gate: true, icon: 'mdi:ray-start-end', label: 'Gate', hint: 'A note stops its slice when the note ends' },
] as const;

const formatPitch = (value: number) => (value > 0 ? `+${Math.round(value)}` : String(Math.round(value)));
const formatSpeed = (value: number) => `${value.toFixed(2)}×`;
</script>

<template>
    <div class="setting">
        <div class="setting-label">Pitch and speed</div>
        <div class="setting-row setting-row--tall">
            <div class="flex gap-4">
                <JuicyKnob
                    :model-value="props.track.pitch"
                    @update:model-value="props.track.setPitch($event)"
                    :min="-SAMPLE_PITCH_RANGE"
                    :max="SAMPLE_PITCH_RANGE"
                    :step="1"
                    :format="formatPitch"
                    :reset-value="0"
                    label="Pitch"
                    hint="Semitones up or down. The length stays the same."
                    :size="60"
                />
                <JuicyKnob
                    :model-value="props.track.speed"
                    @update:model-value="props.track.setSpeed($event)"
                    :min="MIN_SAMPLE_SPEED"
                    :max="MAX_SAMPLE_SPEED"
                    :step="0.01"
                    curve="log"
                    :format="formatSpeed"
                    :reset-value="1"
                    label="Speed"
                    hint="Faster or slower. The pitch stays the same."
                    :size="60"
                />
            </div>
        </div>
    </div>

    <div class="setting">
        <div class="setting-label">Note length</div>
        <div class="setting-row">
            <button
                v-for="mode in LENGTH_MODES"
                :key="mode.label"
                type="button"
                class="iconbtn"
                :data-active="props.track.gate === mode.gate"
                :aria-pressed="props.track.gate === mode.gate"
                v-tooltip.bottom="mode.hint"
                @click="props.track.setGate(mode.gate)"
            >
                <Icon :icon="mode.icon" class="w-5 h-5" />
                <span>{{ mode.label }}</span>
            </button>
        </div>
    </div>

    <div class="setting">
        <div class="setting-label">Direction</div>
        <div class="setting-row">
            <button
                type="button"
                class="iconbtn"
                :data-active="props.track.isReversed"
                :aria-pressed="props.track.isReversed"
                v-tooltip.bottom="'Play the sample (every slice on its own) backwards'"
                @click="props.track.toggleReverse()"
            >
                <Icon icon="jam:refresh-reverse" class="w-5 h-5" />
                <span>Reverse</span>
            </button>
        </div>
    </div>
</template>
