<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, type Component } from 'vue';
import { STEP_COUNT } from '@/juicyloops/constants';
import { provideContainerView } from '@/composables/useContainerView';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import type { TrackType } from '@/juicyloops/tracks/registry';
import { TRACK_META } from './trackMeta';
import JuicySynthTrack from './JuicySynthTrack.vue';
import JuicySamplerTrack from './JuicySamplerTrack.vue';
import JuicyMicrophoneTrack from './JuicyMicrophoneTrack.vue';
import PlayheadBeam from './PlayheadBeam.vue';
import StepRuler from './StepRuler.vue';

/**
 * The tracks of one container, one row each, every one a loop with its own length that can be painted, tweaked and mixed.
 * The rows share one scrolling area; the ruler sticks to its top, the channel heads to its left.
 *
 * The track view shows the current container here, a container window in the song view shows its own.
 * `step` is where the container plays (null while silent); the rows read both through the container view.
 * It is a getter, not a number: a prop that changes every step would re-render every row with it. Only the ruler, the
 * beam and the lit cells follow it.
 */
const props = defineProps<{
    container: TrackContainer;
    step: () => number | null;
    /** A smaller empty state, for a window. */
    compact?: boolean;
}>();

const { addTrack } = useJuicyLoops();
const { selectTrack, isPro } = useWorkspace();

provideContainerView(
    () => props.container,
    () => props.step(),
);

/** Which component renders which track type. */
const TRACK_COMPONENTS: Record<TrackType, Component> = {
    synth: JuicySynthTrack,
    sampler: JuicySamplerTrack,
    microphone: JuicyMicrophoneTrack,
};

const TRACK_TYPES = Object.keys(TRACK_META) as TrackType[];

const tracks = computed(() => props.container.tracks);

/** How many sections the ruler spans: enough for the longest track. */
const sections = computed(() => Math.max(1, ...tracks.value.map((track) => Math.ceil(track.length / STEP_COUNT))));

const add = (type: TrackType) => {
    const track = addTrack(type, props.container);
    selectTrack(track.id);
};
</script>

<template>
    <div v-if="tracks.length" class="timeline" :style="{ '--jl-sections': sections }">
        <div class="timeline-inner">
            <StepRuler :sections="sections" />
            <component v-for="(track, trackIndex) in tracks" :key="track.id" :is="TRACK_COMPONENTS[track.type]" :track="track" :track-index="trackIndex" />
            <PlayheadBeam :sections="sections" />

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

    <div v-else class="hero" :class="{ 'hero--compact': props.compact }">
        <div>
            <h2 class="hero-title">Start with a track</h2>
            <p v-if="isPro" class="hero-text">
                Every track is its own loop, 32 steps unless you say otherwise. Put as many as you like into <b>{{ props.container.name }}</b
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
</template>
