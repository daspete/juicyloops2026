<script setup lang="ts">
import { NOTE_LENGTHS, OSCILLATOR_TYPES, type NoteLength, type OscillatorType } from '@/juicyloops/notes';
import { computed } from 'vue';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';

const props = defineProps<{
    track: SynthTrack;
}>();

/** The length shared by every step, or null when steps differ. */
const sharedLength = computed<NoteLength | null>(() => {
    const first = props.track.ticks[0]?.duration ?? null;
    return props.track.ticks.every((tick) => tick.duration === first) ? first : null;
});

const OSCILLATORS: Record<OscillatorType, { icon: string; label: string }> = {
    sine: { icon: 'mdi:sine-wave', label: 'Sine, soft and round' },
    triangle: { icon: 'mdi:triangle-wave', label: 'Triangle, mellow' },
    square: { icon: 'mdi:square-wave', label: 'Square, hollow and chippy' },
    sawtooth: { icon: 'mdi:sawtooth-wave', label: 'Saw, bright and buzzy' },
};
</script>

<template>
    <div class="setting">
        <div class="setting-label">Waveform</div>
        <div class="setting-row">
            <button
                v-for="type in OSCILLATOR_TYPES"
                :key="type"
                type="button"
                class="iconbtn"
                :data-active="props.track.oscillatorType === type"
                :aria-pressed="props.track.oscillatorType === type"
                v-tooltip.bottom="OSCILLATORS[type].label"
                :aria-label="OSCILLATORS[type].label"
                @click="props.track.setOscillatorType(type)"
            >
                <Icon :icon="OSCILLATORS[type].icon" class="w-5 h-5" />
            </button>
        </div>
    </div>

    <div class="setting">
        <div class="setting-label">Note length · all steps</div>
        <div class="setting-row">
            <button
                v-for="length in NOTE_LENGTHS"
                :key="length.tone"
                type="button"
                class="iconbtn font-mono"
                :data-active="sharedLength === length.tone"
                :aria-pressed="sharedLength === length.tone"
                :aria-label="`${length.steps} ${length.steps === 1 ? 'step' : 'steps'} long`"
                v-tooltip.bottom="`${length.steps} ${length.steps === 1 ? 'step' : 'steps'} long`"
                @click="props.track.setAllNoteLengths(length.tone)"
            >
                {{ length.label }}
            </button>
            <span class="text-xs text-(--jl-muted) pl-1 pr-1.5">steps</span>
        </div>
    </div>
</template>
