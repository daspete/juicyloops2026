<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { type Component } from 'vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { TrackType } from '@/juicyloops/tracks/registry';
import { TRACK_META } from './trackMeta';
import JuicySynthTrack from './JuicySynthTrack.vue';
import JuicySamplerTrack from './JuicySamplerTrack.vue';
import JuicyMicrophoneTrack from './JuicyMicrophoneTrack.vue';
import StepRuler from './StepRuler.vue';

/** The track view: one row per track, each a loop of `STEP_COUNT` steps that can be painted, tweaked and mixed. */
const { currentTick, tracks, addTrack } = useJuicyLoops();

/** Which component renders which track type. */
const TRACK_COMPONENTS: Record<TrackType, Component> = {
    synth: JuicySynthTrack,
    sampler: JuicySamplerTrack,
    microphone: JuicyMicrophoneTrack,
};

const TRACK_TYPES = Object.keys(TRACK_META) as TrackType[];
</script>

<template>
    <div class="min-w-4xl max-w-7xl mx-auto px-4 py-4 flex flex-col gap-2">
        <template v-if="tracks.length">
            <StepRuler :current-tick="currentTick" />
            <div v-for="(track, trackIndex) in tracks" :key="track.id">
                <component :is="TRACK_COMPONENTS[track.type]" :track="track" :track-index="trackIndex" />
            </div>

            <div class="flex items-center gap-2 px-2 pt-2">
                <span class="text-xs font-semibold text-(--jl-muted) uppercase tracking-wider mr-1">Add</span>
                <button
                    v-for="type in TRACK_TYPES"
                    :key="type"
                    type="button"
                    class="chip"
                    :style="{ '--jl-accent': TRACK_META[type].accent }"
                    @click="addTrack(type)"
                >
                    <Icon :icon="TRACK_META[type].icon" class="w-4 h-4" :style="{ color: TRACK_META[type].accent }" />
                    <span>{{ TRACK_META[type].label }}</span>
                </button>
            </div>
        </template>

        <div v-else class="flex flex-col items-center gap-8 pt-16 pb-8 text-center">
            <div>
                <h2 class="font-display font-bold text-4xl tracking-tight">Start with a track</h2>
                <p class="mt-2 text-(--jl-muted)">Every track is a loop of 32 steps. Mix and match as many as you like.</p>
            </div>
            <div class="flex flex-wrap justify-center gap-4">
                <button
                    v-for="type in TRACK_TYPES"
                    :key="type"
                    type="button"
                    class="addcard"
                    :style="{ '--jl-accent': TRACK_META[type].accent }"
                    @click="addTrack(type)"
                >
                    <Icon :icon="TRACK_META[type].icon" class="w-8 h-8" :style="{ color: TRACK_META[type].accent }" />
                    <span class="font-display font-bold text-xl">{{ TRACK_META[type].label }}</span>
                    <span class="text-sm text-(--jl-muted) leading-snug">{{ TRACK_META[type].blurb }}</span>
                </button>
            </div>
        </div>
    </div>
</template>
