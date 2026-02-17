<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';
import { Button } from 'primevue';

const props = defineProps<{
    track: BaseTrack;
}>();

const setEveryNote = (interval: number) => {
    props.track.ticks.forEach((tick, index) => {
        tick.isActive = index % interval === 0;
    });
};

const shiftNotes = (direction: number) => {
    const ticks = props.track.ticks;
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
</script>

<template>
    <div v-if="props.track" class="flex items-center gap-1">
        <div class="flex items-center gap-1 rounded bg-surface-800">
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
            <div class="flex items-center gap-1 rounded bg-surface-800">
                <Button size="small" text @click="shiftNotes(-1)">
                    <Icon icon="material-symbols-light:move-selection-left" class="w-6 h-6" />
                </Button>
                <Button size="small" text @click="shiftNotes(1)">
                    <Icon icon="material-symbols-light:move-selection-right" class="w-6 h-6" />
                </Button>
            </div>
        </div>
    </div>
</template>
