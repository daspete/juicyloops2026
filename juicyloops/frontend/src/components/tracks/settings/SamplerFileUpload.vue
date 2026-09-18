<script setup lang="ts">
import type { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { Icon } from '@iconify/vue';
import { useTemplateRef } from 'vue';

const props = defineProps<{
    track: SamplerTrack;
    label?: string;
}>();

const input = useTemplateRef<HTMLInputElement>('input');

const onFileSelect = async (event: Event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) {
        return;
    }

    await props.track.setFile(file);
    (event.target as HTMLInputElement).value = '';
};
</script>

<template>
    <button type="button" class="chip" @click="input?.click()">
        <Icon icon="mdi:folder-music-outline" class="w-4 h-4" />
        <span>{{ props.label || 'Choose a file' }}</span>
    </button>
    <input ref="input" type="file" accept="audio/*" class="hidden" @change="onFileSelect" />
</template>
