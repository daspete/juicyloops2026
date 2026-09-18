<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const FILLS = [
    { interval: 1, label: 'All', hint: 'Fill every step' },
    { interval: 2, label: '1/2', hint: 'Fill every 2nd step' },
    { interval: 4, label: '1/4', hint: 'Fill every beat' },
    { interval: 8, label: '1/8', hint: 'Fill every 2nd beat' },
];
</script>

<template>
    <div class="setting">
        <div class="setting-label">Fill</div>
        <div class="setting-row">
            <button
                v-for="fill in FILLS"
                :key="fill.interval"
                type="button"
                class="iconbtn font-mono"
                v-tooltip.bottom="fill.hint"
                :aria-label="fill.hint"
                @click="props.track.activateEveryNth(fill.interval)"
            >
                {{ fill.label }}
            </button>
            <span class="w-px h-4 bg-(--jl-line) mx-0.5"></span>
            <button type="button" class="iconbtn" v-tooltip.bottom="'Roll the dice on a new pattern'" @click="props.track.randomize()">
                <Icon icon="mdi:dice-5-outline" class="w-5 h-5" />
                <span>Random</span>
            </button>
            <button type="button" class="iconbtn" v-tooltip.bottom="'Switch every step off'" @click="props.track.clear()">
                <Icon icon="mdi:eraser-variant" class="w-5 h-5" />
                <span>Clear</span>
            </button>
        </div>
    </div>

    <div class="setting">
        <div class="setting-label">Nudge</div>
        <div class="setting-row">
            <button type="button" class="iconbtn" aria-label="Move the pattern one step earlier" v-tooltip.bottom="'Move the pattern one step earlier'" @click="props.track.rotateTicks(-1)">
                <Icon icon="mdi:arrow-left" class="w-5 h-5" />
            </button>
            <button type="button" class="iconbtn" aria-label="Move the pattern one step later" v-tooltip.bottom="'Move the pattern one step later'" @click="props.track.rotateTicks(1)">
                <Icon icon="mdi:arrow-right" class="w-5 h-5" />
            </button>
        </div>
    </div>
</template>
