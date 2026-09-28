<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import ContainerBar from '../containers/ContainerBar.vue';
import ContainerTracks from './ContainerTracks.vue';

/** The track view: the container tabs (Pro) above the tracks of the current container, which loops while it plays. */
const { currentStep, currentContainer, isPlaying } = useJuicyLoops();
const { isPro } = useWorkspace();

/** A getter, so the playhead moving does not re-render the track rows (see `ContainerTracks`). */
const step = (): number | null => (isPlaying.value ? currentStep.value : null);
</script>

<template>
    <div class="page">
        <ContainerBar v-if="isPro" />
        <ContainerTracks :container="currentContainer" :step="step" />
    </div>
</template>
