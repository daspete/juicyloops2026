<script setup lang="ts">
import { NOTE_LENGTHS, OSCILLATOR_TYPES, type OscillatorType } from '@/juicyloops/notes';
import { computed } from 'vue';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';

const props = defineProps<{
    track: SynthTrack;
}>();

/** The length (steps) shared by every note, or null when notes differ. Without notes, the length a new step gets. */
const sharedLength = computed<number | null>(() => {
    const notes = props.track.notes;
    const first = notes[0]?.length ?? props.track.stepLength;
    return notes.every((note) => note.length === first) ? first : null;
});

const OSCILLATORS: Record<OscillatorType, { icon: string; label: string }> = {
    sine: { icon: 'mdi:sine-wave', label: 'Sine, soft and round' },
    triangle: { icon: 'mdi:triangle-wave', label: 'Triangle, mellow' },
    square: { icon: 'mdi:square-wave', label: 'Square, hollow and chippy' },
    sawtooth: { icon: 'mdi:sawtooth-wave', label: 'Saw, bright and buzzy' },
};
</script>

<template>
    <div v-if="props.track.model === 'classic'" class="setting">
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
                :data-active="sharedLength === length.steps"
                :aria-pressed="sharedLength === length.steps"
                :aria-label="`${length.steps} ${length.steps === 1 ? 'step' : 'steps'} long`"
                v-tooltip.bottom="`${length.steps} ${length.steps === 1 ? 'step' : 'steps'} long`"
                @click="props.track.setAllNoteLengths(length.steps)"
            >
                {{ length.label }}
            </button>
            <span class="text-xs text-(--jl-muted) pl-1 pr-1.5">steps</span>
        </div>
    </div>
</template>
