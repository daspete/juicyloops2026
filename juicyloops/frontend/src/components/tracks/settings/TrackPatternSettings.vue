<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';
import { STEP_COUNT, TRACK_LENGTHS } from '@/juicyloops/constants';

const props = defineProps<{
    track: BaseTrack;
}>();

/** What a length means against the section: shorter patterns repeat, longer ones spill over. */
const lengthHint = (length: number): string => {
    if (length === STEP_COUNT) {
        return 'One section';
    }
    if (length < STEP_COUNT) {
        const times = STEP_COUNT / length;
        return Number.isInteger(times) ? `Repeats ${times} times per section` : `Repeats every ${length} steps`;
    }
    return `${length / STEP_COUNT} sections long`;
};

const FILLS = [
    { interval: 1, label: 'All', hint: 'Fill every step' },
    { interval: 2, label: '1/2', hint: 'Fill every 2nd step' },
    { interval: 4, label: '1/4', hint: 'Fill every beat' },
    { interval: 8, label: '1/8', hint: 'Fill every 2nd beat' },
];
</script>

<template>
    <div class="setting">
        <div class="setting-label">Length · steps</div>
        <div class="setting-row">
            <button
                v-for="length in TRACK_LENGTHS"
                :key="length"
                type="button"
                class="iconbtn font-mono"
                :data-active="props.track.length === length"
                :aria-pressed="props.track.length === length"
                v-tooltip.bottom="lengthHint(length)"
                :aria-label="`${length} steps, ${lengthHint(length)}`"
                @click="props.track.setLength(length)"
            >
                {{ length }}
            </button>
        </div>
    </div>

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
