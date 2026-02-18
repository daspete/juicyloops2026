<script setup lang="ts">
import type { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import { Icon } from '@iconify/vue';
import { FileUpload, type FileUploadSelectEvent } from 'primevue';

const props = defineProps<{
    track: SamplerTrack;
    label?: string;
}>();

const emit = defineEmits<{
    (e: 'uploaded'): void;
}>();

const onFileSelect = async (event: FileUploadSelectEvent) => {
    await props.track.setFile(Array.isArray(event.files) ? event.files[0] : event.files);
    emit('uploaded');
};
</script>

<template>
    <div v-if="props.track" class="flex items-center gap-1">
        <div class="flex items-center gap-1 rounded bg-surface-800">
            <FileUpload
                mode="basic"
                @select="onFileSelect"
                customUpload
                auto
                :chooseLabel="props.label || 'Select a sample'"
                :chooseButtonProps="{ size: 'small' }"
            >
                <template #chooseicon>
                    <Icon icon="mdi:upload" class="w-5 h-5" />
                </template>
            </FileUpload>
        </div>
    </div>
</template>
