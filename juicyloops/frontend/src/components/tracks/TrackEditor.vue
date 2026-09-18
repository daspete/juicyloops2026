<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, type Component } from 'vue';
import { STEP_COUNT } from '@/juicyloops/constants';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import type { TrackType } from '@/juicyloops/tracks/registry';
import { TRACK_META } from './trackMeta';
import { BEAT_SIZE } from './steps';
import JuicySynthTrack from './JuicySynthTrack.vue';
import JuicySamplerTrack from './JuicySamplerTrack.vue';
import JuicyMicrophoneTrack from './JuicyMicrophoneTrack.vue';
import StepRuler from './StepRuler.vue';
import ContainerBar from '../containers/ContainerBar.vue';

/**
 * The track view: the tracks of the current container, one row each,
 * every one a loop with its own length that can be painted, tweaked and mixed.
 * The rows share one scrolling workspace; the ruler sticks to its top, the channel heads to its left.
 */
const { currentStep, currentContainer, tracks, addTrack, isPlaying } = useJuicyLoops();
const { selectTrack, isPro } = useWorkspace();

/** Which component renders which track type. */
const TRACK_COMPONENTS: Record<TrackType, Component> = {
    synth: JuicySynthTrack,
    sampler: JuicySamplerTrack,
    microphone: JuicyMicrophoneTrack,
};

const TRACK_TYPES = Object.keys(TRACK_META) as TrackType[];

/** How many sections the ruler spans: enough for the longest track. */
const sections = computed(() => Math.max(1, ...tracks.value.map((track) => Math.ceil(track.length / STEP_COUNT))));

/** The playhead beam: where the ruler's current step sits, in the same units the grids are laid out in. */
const beamStyle = computed(() => {
    const step = currentStep.value % (sections.value * STEP_COUNT);
    const beat = Math.floor(step / BEAT_SIZE);
    const cell = step % BEAT_SIZE;
    return { left: `calc(var(--jl-head-space) + ${beat} * (var(--jl-beat-w) + var(--jl-beat-gap)) + ${cell} * (var(--jl-cell-w) + var(--jl-cell-gap)))` };
});

const add = (type: TrackType) => {
    const track = addTrack(type);
    selectTrack(track.id);
};
</script>

<template>
    <div class="page">
        <ContainerBar v-if="isPro" />
        <div v-if="tracks.length" class="timeline" :style="{ '--jl-sections': sections }">
            <div class="timeline-inner">
                <StepRuler :current-step="isPlaying ? currentStep : -1" :sections="sections" />
                <component v-for="(track, trackIndex) in tracks" :key="track.id" :is="TRACK_COMPONENTS[track.type]" :track="track" :track-index="trackIndex" />
                <div v-if="isPlaying" class="beam" :style="beamStyle" aria-hidden="true"></div>

                <div class="addrow">
                    <span class="eyebrow">Add track</span>
                    <button
                        v-for="type in TRACK_TYPES"
                        :key="type"
                        type="button"
                        class="chip chip--juice"
                        :style="{ '--jl-accent': TRACK_META[type].accent }"
                        @click="add(type)"
                    >
                        <Icon :icon="TRACK_META[type].icon" class="w-4 h-4" :style="{ color: TRACK_META[type].accent }" />
                        <span>{{ TRACK_META[type].label }}</span>
                    </button>
                </div>
            </div>
        </div>

        <div v-else class="hero">
            <div>
                <h2 class="hero-title">Start with <mark>a track</mark></h2>
                <p v-if="isPro" class="hero-text">
                    Every track is its own loop, 32 steps unless you say otherwise. Put as many as you like into <b>{{ currentContainer.name }}</b
                    >, then arrange your containers in the song.
                </p>
                <p v-else class="hero-text">Every track is its own loop, 32 steps unless you say otherwise. Add one, tap a few steps, press play.</p>
            </div>
            <div class="hero-cards">
                <button v-for="type in TRACK_TYPES" :key="type" type="button" class="addcard" :style="{ '--jl-accent': TRACK_META[type].accent }" @click="add(type)">
                    <span class="track-badge"><Icon :icon="TRACK_META[type].icon" class="w-6 h-6" /></span>
                    <span class="addcard-title">{{ TRACK_META[type].label }}</span>
                    <span class="addcard-text">{{ TRACK_META[type].blurb }}</span>
                </button>
            </div>
        </div>
    </div>
</template>
