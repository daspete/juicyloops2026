<script setup lang="ts">
import { computed } from 'vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import ContainerBar from '../containers/ContainerBar.vue';
import ContainerTracks from './ContainerTracks.vue';

/** The track view: the container tabs (Pro) above the tracks of the current container, which loops while it plays. */
const { currentStep, currentContainer, isPlaying } = useJuicyLoops();
const { isPro } = useWorkspace();

const step = computed(() => (isPlaying.value ? currentStep.value : null));
</script>

<template>
    <div class="page">
        <ContainerBar v-if="isPro" />
        <ContainerTracks :container="currentContainer" :step="step" />
    </div>
</template>
