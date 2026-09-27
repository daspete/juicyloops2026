<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';

const props = defineProps<{
    track: BaseTrack;
}>();

const MODES = [
    { cuts: true, icon: 'mdi:content-cut', label: 'Cut', hint: 'A new note stops the one still sounding' },
    { cuts: false, icon: 'mdi:layers-outline', label: 'Overlap', hint: 'Notes ring on under the next one' },
] as const;
</script>

<template>
    <div class="setting">
        <div class="setting-label">Notes</div>
        <div class="setting-row">
            <button
                v-for="mode in MODES"
                :key="mode.label"
                type="button"
                class="iconbtn"
                :data-active="props.track.cutsNotes === mode.cuts"
                :aria-pressed="props.track.cutsNotes === mode.cuts"
                v-tooltip.bottom="mode.hint"
                @click="props.track.setCutsNotes(mode.cuts)"
            >
                <Icon :icon="mode.icon" class="w-5 h-5" />
                <span>{{ mode.label }}</span>
            </button>
        </div>
    </div>
</template>
