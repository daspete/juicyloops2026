<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import type { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { computed } from 'vue';
import SamplerFileUpload from './SamplerFileUpload.vue';
import SynthEnvelopeSettings from './SynthEnvelopeSettings.vue';
import SynthSettings from './SynthSettings.vue';
import TrackSampleSettings from './TrackSampleSettings.vue';

/** The Sound page of the detail panel: whatever this kind of track lets you shape about every step it plays. */
const props = defineProps<{
    track: BaseTrack;
}>();

const synth = computed(() => (props.track.type === 'synth' ? (props.track as SynthTrack) : null));
const sample = computed(() => (props.track.type === 'sampler' || props.track.type === 'microphone' ? (props.track as SampleTrack) : null));
const sampler = computed(() => (props.track.type === 'sampler' ? (props.track as SamplerTrack) : null));
</script>

<template>
    <template v-if="synth">
        <SynthSettings :track="synth" />
        <SynthEnvelopeSettings :track="synth" />
    </template>
    <template v-else-if="sample">
        <TrackSampleSettings :track="sample" />
        <div v-if="sampler" class="setting">
            <div class="setting-label">Sample</div>
            <div class="setting-row setting-row--loose">
                <span v-if="sampler.sampleName" class="setting-file" :title="sampler.sampleName">{{ sampler.sampleName }}</span>
                <span v-else class="setting-hint">No file yet</span>
                <SamplerFileUpload :track="sampler" :label="sampler.hasSample ? 'Change file' : 'Choose a file'" />
            </div>
        </div>
    </template>
</template>
