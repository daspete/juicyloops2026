<script setup lang="ts">
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { Button } from 'primevue';

const props = defineProps<{
    track: SynthTrack;
}>();

const changeOctave = (direction: number) => {
    props.track.ticks.forEach((tick) => {
        const match = tick.note.match(/([A-G]#?)(\d)/);
        if (match) {
            const note = match[1];
            if (!match[2]) return; // If there's no octave number, skip
            let octave = parseInt(match[2]);
            octave += direction;
            octave = Math.max(0, Math.min(10, octave)); // Keep octave between 0 and 10
            tick.note = `${note}${octave}`;
        }
    });
};
</script>

<template>
    <div v-if="props.track" class="flex items-center gap-1">
        <div class="flex items-center gap-1 rounded bg-surface-800">
            <Button size="small" text @click="changeOctave(1)">
                <Icon icon="ic:baseline-keyboard-arrow-up" class="w-6 h-6" />
            </Button>

            <Button size="small" text @click="changeOctave(-1)">
                <Icon icon="ic:baseline-keyboard-arrow-down" class="w-6 h-6" />
            </Button>
        </div>
    </div>
</template>
