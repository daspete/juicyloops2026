<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { Button } from 'primevue';
import { computed } from 'vue';

const { selectedTrack } = useJuicyLoops();

const track = computed(() => {
    return selectedTrack.value as unknown as SynthTrack;
});

const setEveryNote = (interval: number) => {
    track.value.ticks.forEach((tick, index) => {
        tick.isActive = index % interval === 0;
    });
};

const shiftNotes = (direction: number) => {
    const ticks = track.value.ticks;
    if (direction === 1) {
        // Shift right
        const lastTick = ticks.pop();
        if (lastTick) {
            ticks.unshift(lastTick);
        }
    } else {
        // Shift left
        const firstTick = ticks.shift();
        if (firstTick) {
            ticks.push(firstTick);
        }
    }
};

const changeOctave = (direction: number) => {
    track.value.ticks.forEach((tick) => {
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
    <div v-if="track">
        <div class="flex flex-col items-center gap-2 flex-wrap">
            <div class="flex items-center gap-1 rounded bg-surface-700">
                <Button size="small" :text="track.synth.oscillator.type !== 'sine'" @click="track.setSynthType('sine')">
                    <Icon icon="mdi:sine-wave" class="w-6 h-6" />
                </Button>
                <Button size="small" :text="track.synth.oscillator.type !== 'square'" @click="track.setSynthType('square')">
                    <Icon icon="mdi:square-wave" class="w-6 h-6" />
                </Button>
                <Button size="small" :text="track.synth.oscillator.type !== 'triangle'" @click="track.setSynthType('triangle')">
                    <Icon icon="mdi:triangle-wave" class="w-6 h-6" />
                </Button>
                <Button size="small" :text="track.synth.oscillator.type !== 'sawtooth'" @click="track.setSynthType('sawtooth')">
                    <Icon icon="mdi:sawtooth-wave" class="w-6 h-6" />
                </Button>
            </div>

            <div class="flex items-center gap-1 rounded bg-surface-700">
                <Button size="small" text @click="setEveryNote(1)">
                    <Icon icon="ph:number-circle-one" class="w-6 h-6" />
                </Button>
                <Button size="small" text @click="setEveryNote(2)">
                    <Icon icon="ph:number-circle-two" class="w-6 h-6" />
                </Button>
                <Button size="small" text @click="setEveryNote(4)">
                    <Icon icon="ph:number-circle-four" class="w-6 h-6" />
                </Button>
                <Button size="small" text @click="setEveryNote(8)">
                    <Icon icon="ph:number-circle-eight" class="w-6 h-6" />
                </Button>
            </div>

            <div class="flex gap-2">
                <div class="flex items-center gap-1 rounded bg-surface-700">
                    <Button size="small" text @click="shiftNotes(-1)">
                        <Icon icon="material-symbols-light:move-selection-left" class="w-6 h-6" />
                    </Button>
                    <Button size="small" text @click="shiftNotes(1)">
                        <Icon icon="material-symbols-light:move-selection-right" class="w-6 h-6" />
                    </Button>
                </div>

                <div class="flex items-center gap-1 rounded bg-surface-700">
                    <Button size="small" text @click="changeOctave(1)">
                        <Icon icon="ic:baseline-keyboard-arrow-up" class="w-6 h-6" />
                    </Button>

                    <Button size="small" text @click="changeOctave(-1)">
                        <Icon icon="ic:baseline-keyboard-arrow-down" class="w-6 h-6" />
                    </Button>
                </div>
            </div>
        </div>
    </div>
</template>
