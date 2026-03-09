<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Slider } from 'primevue';

const props = defineProps<{
    track: BaseTrack;
}>();
</script>

<template>
    <div class="w-full overflow-x-auto pb-2" v-if="props.track">
        <div class="grid grid-cols-32 gap-1 min-w-[40rem] sm:min-w-0">
            <div v-for="(tick, tickIndex) in props.track.ticks" :key="tickIndex">
                <div class="w-full rounded shadow px-1 py-2 bg-surface-800 flex flex-col gap-4">
                    <div class="flex flex-col items-center justify-center w-full gap-4">
                        <div class="text-xs">{{ Math.round(tick.volume * 100) }}%</div>
                        <Slider v-model="tick.volume" :min="0" :max="1" :step="0.01" orientation="vertical" class="w-3 h-24" />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
