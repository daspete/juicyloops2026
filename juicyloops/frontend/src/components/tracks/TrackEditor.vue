<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, type Component } from 'vue';
import { STEP_COUNT } from '@/juicyloops/constants';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { TrackType } from '@/juicyloops/tracks/registry';
import { TRACK_META } from './trackMeta';
import JuicySynthTrack from './JuicySynthTrack.vue';
import JuicySamplerTrack from './JuicySamplerTrack.vue';
import JuicyMicrophoneTrack from './JuicyMicrophoneTrack.vue';
import StepRuler from './StepRuler.vue';
import ContainerBar from '../containers/ContainerBar.vue';

/**
 * The track view: the tracks of the current container, one row each,
 * every one a loop with its own length that can be painted, tweaked and mixed.
 */
const { currentStep, currentContainer, tracks, addTrack } = useJuicyLoops();

/** Which component renders which track type. */
const TRACK_COMPONENTS: Record<TrackType, Component> = {
    synth: JuicySynthTrack,
    sampler: JuicySamplerTrack,
    microphone: JuicyMicrophoneTrack,
};

const TRACK_TYPES = Object.keys(TRACK_META) as TrackType[];

/** How many sections the ruler spans: enough for the longest track. */
const sections = computed(() => Math.max(1, ...tracks.value.map((track) => Math.ceil(track.length / STEP_COUNT))));
</script>

<template>
    <div class="page gap-2">
        <ContainerBar class="mb-2" />
        <template v-if="tracks.length">
            <div class="timeline" :style="{ '--jl-sections': sections }">
                <div class="timeline-inner">
                    <StepRuler :current-step="currentStep" :sections="sections" />
                    <component v-for="(track, trackIndex) in tracks" :key="track.id" :is="TRACK_COMPONENTS[track.type]" :track="track" :track-index="trackIndex" />
                </div>
            </div>

            <div class="flex items-center gap-2 px-2 pt-2">
                <span class="eyebrow mr-1">Add</span>
                <button
                    v-for="type in TRACK_TYPES"
                    :key="type"
                    type="button"
                    class="chip chip--juice"
                    :style="{ '--jl-accent': TRACK_META[type].accent }"
                    @click="addTrack(type)"
                >
                    <Icon :icon="TRACK_META[type].icon" class="w-4 h-4" :style="{ color: TRACK_META[type].accent }" />
                    <span>{{ TRACK_META[type].label }}</span>
                </button>
            </div>
        </template>

        <div v-else class="hero">
            <div>
                <h2 class="hero-title">Start with <mark>a track</mark></h2>
                <p class="mt-3 text-(--jl-muted) max-w-xl">
                    Every track is its own loop, 32 steps unless you say otherwise. Put as many as you like into <b class="text-(--jl-text)">{{ currentContainer.name }}</b>, then arrange your
                    containers in the song.
                </p>
            </div>
            <div class="hero-cards">
                <button
                    v-for="type in TRACK_TYPES"
                    :key="type"
                    type="button"
                    class="addcard"
                    :style="{ '--jl-accent': TRACK_META[type].accent }"
                    @click="addTrack(type)"
                >
                    <span class="track-badge"><Icon :icon="TRACK_META[type].icon" class="w-6 h-6" /></span>
                    <span class="addcard-title">{{ TRACK_META[type].label }}</span>
                    <span class="text-sm text-(--jl-muted) leading-snug">{{ TRACK_META[type].blurb }}</span>
                </button>
            </div>
        </div>
    </div>
</template>
