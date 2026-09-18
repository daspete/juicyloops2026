<script setup lang="ts">
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import { Icon } from '@iconify/vue';

const props = defineProps<{
    track: SampleTrack;
}>();
</script>

<template>
    <div class="setting">
        <div class="setting-label">Direction</div>
        <div class="setting-row">
            <button
                type="button"
                class="iconbtn"
                :data-active="props.track.isReversed"
                :aria-pressed="props.track.isReversed"
                v-tooltip.bottom="'Play the sample backwards'"
                @click="props.track.toggleReverse()"
            >
                <Icon icon="jam:refresh-reverse" class="w-5 h-5" />
                <span>Reverse</span>
            </button>
        </div>
    </div>
</template>
