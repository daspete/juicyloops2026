<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, ref } from 'vue';
import { SAMPLER_FACTORY, SYNTH_FACTORY, usePresets, type SamplerPreset, type SynthPreset } from '@/composables/usePresets';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import type { SampleTrack } from '@/juicyloops/tracks/SampleTrack';
import type { SamplerTrack } from '@/juicyloops/tracks/SamplerTrack';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import SongMenu, { type SongMenuItem } from '../song/SongMenu.vue';
import SamplerFileUpload from '../tracks/settings/SamplerFileUpload.vue';
import SynthBendSettings from '../tracks/settings/SynthBendSettings.vue';
import SynthEnvelopeSettings from '../tracks/settings/SynthEnvelopeSettings.vue';
import SynthSettings from '../tracks/settings/SynthSettings.vue';
import TrackSampleSettings from '../tracks/settings/TrackSampleSettings.vue';
import TrackVoiceSettings from '../tracks/settings/TrackVoiceSettings.vue';
import { TRACK_META } from '../tracks/trackMeta';

/**
 * The first device of a track's chain: its sound source. A synth shows its waveform and envelope (full: bend and voice
 * too), a sampler or a microphone its sample, pitch and speed. The ⋯ menu holds instrument presets.
 */
const props = defineProps<{
    track: BaseTrack;
    face: 'macro' | 'full';
}>();

const { user, saveSynthPreset, removeSynthPreset, saveSamplerPreset, removeSamplerPreset } = usePresets();

const meta = computed(() => TRACK_META[props.track.type]);
const synth = computed(() => (props.track.type === 'synth' ? (props.track as SynthTrack) : null));
const sample = computed(() => (props.track.type === 'sampler' || props.track.type === 'microphone' ? (props.track as SampleTrack) : null));
const sampler = computed(() => (props.track.type === 'sampler' ? (props.track as SamplerTrack) : null));

const ownFace = ref<'macro' | 'full' | null>(null);
const face = computed(() => ownFace.value ?? props.face);

/* Remounted after a preset so every control reads the new values. */
const version = ref(0);

const applySynth = (preset: SynthPreset) => {
    const track = synth.value!;
    track.setOscillatorType(preset.oscillatorType);
    for (const key of ['attack', 'decay', 'sustain', 'release'] as const) {
        track.setEnvelope(key, preset.envelope[key]);
    }
    if (preset.bendRange !== undefined) {
        track.setBendRange(preset.bendRange);
    }
    version.value++;
};

const applySampler = (preset: SamplerPreset) => {
    const track = sample.value!;
    track.setPitch(preset.pitch);
    track.setSpeed(preset.speed);
    track.setReversed(preset.isReversed);
    track.setGate(preset.gate);
    version.value++;
};

const menu = ref<{ x: number; y: number } | null>(null);
const naming = ref(false);
const presetName = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

const openMenu = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.value = event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom + 4 };
};

const startSaving = async () => {
    presetName.value = `My ${meta.value.label.toLowerCase()}`;
    naming.value = true;
    await nextTick();
    nameInput.value?.select();
};

const savePreset = () => {
    const name = presetName.value.trim();
    naming.value = false;
    if (!name) {
        return;
    }
    if (synth.value) {
        const track = synth.value;
        saveSynthPreset({ name, oscillatorType: track.oscillatorType, envelope: { ...track.envelope }, bendRange: track.bendRange });
    } else if (sample.value) {
        const track = sample.value;
        saveSamplerPreset({ name, pitch: track.pitch, speed: track.speed, isReversed: track.isReversed, gate: track.gate });
    }
};

const menuItems = computed<SongMenuItem[]>(() => {
    const items: SongMenuItem[] = [];
    if (synth.value) {
        items.push(...SYNTH_FACTORY.map((preset) => ({ label: preset.name, icon: 'mdi:star-four-points-outline', action: () => applySynth(preset) })));
        if (user.value.synth.length) {
            items.push({}, ...user.value.synth.map((preset) => ({ label: preset.name, icon: 'mdi:account-music-outline', action: () => applySynth(preset) })));
        }
    } else if (sample.value) {
        items.push(...SAMPLER_FACTORY.map((preset) => ({ label: preset.name, icon: 'mdi:star-four-points-outline', action: () => applySampler(preset) })));
        if (user.value.sampler.length) {
            items.push({}, ...user.value.sampler.map((preset) => ({ label: preset.name, icon: 'mdi:account-music-outline', action: () => applySampler(preset) })));
        }
    }
    items.push({}, { label: 'Save as preset…', icon: 'mdi:content-save-outline', action: () => void startSaving() });
    const mine = synth.value ? user.value.synth : user.value.sampler;
    items.push(
        ...mine.map((preset) => ({
            label: `Delete "${preset.name}"`,
            icon: 'mdi:delete-outline',
            action: () => (synth.value ? removeSynthPreset(preset.name) : removeSamplerPreset(preset.name)),
        })),
    );
    items.push({}, { label: face.value === 'macro' ? 'Show every setting' : 'Show the main settings', icon: 'mdi:tune-variant', action: () => (ownFace.value = face.value === 'macro' ? 'full' : 'macro') });
    return items;
});
</script>

<template>
    <article class="device-card device-card--instrument" :class="{ 'device-card--full': face === 'full' }" data-on="true" :style="{ '--jl-accent': meta.accent }" :aria-label="`${meta.label} instrument`">
        <header class="device-card-head" @contextmenu.prevent="openMenu">
            <span class="device-power device-power--fixed" aria-hidden="true"><Icon :icon="meta.icon" class="w-4 h-4" /></span>
            <span class="device-card-name">{{ meta.label }}</span>
            <span class="device-card-kind">Instrument</span>
            <button type="button" class="iconbtn device-card-menu" :aria-label="`${meta.label} presets`" v-tooltip.top="'Presets and more'" @click="openMenu">
                <Icon icon="mdi:dots-horizontal" class="w-4 h-4" />
            </button>
        </header>
        <div :key="version" class="device-card-body device-card-body--settings settings">
            <template v-if="synth">
                <SynthSettings :track="synth" />
                <SynthEnvelopeSettings :track="synth" />
                <template v-if="face === 'full'">
                    <SynthBendSettings :track="synth" />
                    <TrackVoiceSettings :track="synth" />
                </template>
            </template>
            <template v-else-if="sample">
                <div v-if="sampler" class="setting">
                    <div class="setting-label">Sample</div>
                    <div class="setting-row setting-row--loose">
                        <span v-if="sampler.sampleName" class="setting-file" :title="sampler.sampleName">{{ sampler.sampleName }}</span>
                        <span v-else class="setting-hint">No file yet</span>
                        <SamplerFileUpload :track="sampler" :label="sampler.hasSample ? 'Change' : 'Choose a file'" />
                    </div>
                </div>
                <TrackSampleSettings :track="sample" />
                <TrackVoiceSettings v-if="face === 'full'" :track="sample" />
            </template>
            <form v-if="naming" class="device-card-save" @submit.prevent="savePreset">
                <input ref="nameInput" v-model="presetName" class="input" type="text" maxlength="40" aria-label="Preset name" @keydown.escape.stop="naming = false" />
                <button type="submit" class="iconbtn" aria-label="Save preset"><Icon icon="mdi:check" class="w-4 h-4" /></button>
            </form>
        </div>
        <SongMenu v-if="menu" :items="menuItems" :x="menu.x" :y="menu.y" :title="`${meta.label} presets`" @close="menu = null" />
    </article>
</template>
