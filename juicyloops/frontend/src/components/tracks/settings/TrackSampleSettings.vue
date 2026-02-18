<script setup lang="ts">
import type { MicrophoneTrack } from '@/juicyloops/tracks/MicrophoneTrack';
import type { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { Icon } from '@iconify/vue';
import { ToggleSwitch } from 'primevue';
import { ref } from 'vue';

const props = defineProps<{
    track: SamplerTrack | MicrophoneTrack;
}>();

const isReverse = ref(props.track.isReversed);
</script>

<template>
    <div v-if="props.track" class="flex items-center gap-1">
        <div class="flex items-stretch gap-1 rounded bg-surface-800 h-9">
            <div class="flex gap-2 items-center px-2">
                <Icon icon="jam:refresh-reverse" class="w-5 h-5" />
                <ToggleSwitch v-model="isReverse" @change="props.track.toggleReverse()" />
            </div>
        </div>
    </div>
</template>
