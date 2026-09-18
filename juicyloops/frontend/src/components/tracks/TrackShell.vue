<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';
import { Slider, useConfirm } from 'primevue';
import { computed, ref } from 'vue';
import EffectRack from '../effects/EffectRack.vue';
import TrackPatternSettings from './settings/TrackPatternSettings.vue';
import TrackVolumeSettings from './settings/TrackVolumeSettings.vue';
import { TRACK_META } from './trackMeta';

/**
 * Everything every track row has in common: the coloured identity, mute + volume,
 * the tool bar, and the inline panels (velocity lane and the Tweak panel with sound, pattern and effects).
 * The row is a two-row grid: head and step grid side by side, everything that opens below them across the full width.
 *
 * Slots:
 *  - `actions`  extra tool buttons (before the shared ones)
 *  - default    main content (usually the tick grid)
 *  - `expanded` content shown below the grid (piano roll, waveform, ...)
 *  - `sound`    track specific controls for the Sound card of the Tweak panel
 */
const props = defineProps<{
    track: BaseTrack;
    trackIndex: number;
    /** True when the default slot shows the step grid, so an empty grid can get a first-use hint. */
    hasGrid?: boolean;
}>();

const { removeTrack, duplicateTrack } = useJuicyLoops();
const confirm = useConfirm();

const meta = computed(() => TRACK_META[props.track.type]);

const isVelocityOpen = ref(false);
const isTweakOpen = ref(false);

type TweakTab = 'sound' | 'pattern' | 'effects';
const tweakTab = ref<TweakTab>('sound');
const TWEAK_TABS: readonly { key: TweakTab; label: string; icon: string; note: string }[] = [
    { key: 'sound', label: 'Sound', icon: 'mdi:waveform', note: 'How every step of this track sounds' },
    { key: 'pattern', label: 'Pattern', icon: 'mdi:dots-grid', note: 'Length and quick edits of the whole loop' },
    { key: 'effects', label: 'Effects', icon: 'mdi:auto-fix', note: 'In signal order, drag a chip to reorder' },
];

const isPatternEmpty = computed(() => !props.track.ticks.some((tick) => tick.isActive));

const volumeLabel = computed(() => `${props.track.volume > 0 ? '+' : ''}${props.track.volume.toFixed(1)} dB`);

const confirmRemove = (event: MouseEvent) => {
    confirm.require({
        target: event.currentTarget as HTMLElement,
        message: `Remove this ${meta.value.label} track?`,
        acceptLabel: 'Remove',
        rejectLabel: 'Keep',
        acceptProps: { severity: 'danger', size: 'small' },
        rejectProps: { text: true, size: 'small' },
        accept: () => removeTrack(props.track.id),
    });
};
</script>

<template>
    <div class="track" :class="{ 'track--muted': props.track.isMuted }" :style="{ '--jl-accent': meta.accent }">
        <div class="track-inner">
            <div class="track-head">
                <div class="flex items-center gap-2 h-8">
                    <span class="track-badge"><Icon :icon="meta.icon" class="w-4 h-4" /></span>
                    <span class="track-name">{{ meta.label }}</span>
                    <span class="track-index">{{ props.trackIndex + 1 }}</span>
                    <span class="track-length" v-tooltip.bottom="'Steps in this loop. Change it under Tweak → Pattern.'">{{ props.track.length }} st</span>
                    <div class="flex-1"></div>
                    <button type="button" class="iconbtn" aria-label="Duplicate track" v-tooltip.bottom="'Duplicate track'" @click="duplicateTrack(props.track.id)">
                        <Icon icon="mdi:content-copy" class="w-4 h-4" />
                    </button>
                    <button type="button" class="iconbtn iconbtn--danger" aria-label="Remove track" v-tooltip.bottom="'Remove track'" @click="confirmRemove">
                        <Icon icon="mdi:trash-can-outline" class="w-4 h-4" />
                    </button>
                </div>

                <div class="flex items-center gap-2 h-7">
                    <button
                        type="button"
                        class="iconbtn"
                        :data-active="props.track.isMuted"
                        v-tooltip.bottom="props.track.isMuted ? 'Unmute' : 'Mute'"
                        :aria-label="props.track.isMuted ? 'Unmute' : 'Mute'"
                        :aria-pressed="props.track.isMuted"
                        @click="props.track.toggleMute()"
                    >
                        <Icon :icon="props.track.isMuted ? 'mdi:volume-off' : 'mdi:volume-high'" class="w-4 h-4" />
                    </button>
                    <Slider
                        :model-value="props.track.volume"
                        @update:model-value="props.track.setVolume($event as number)"
                        :min="-40"
                        :max="6"
                        :step="0.5"
                        class="flex-1"
                        aria-label="Track volume"
                    />
                    <span class="font-mono text-xs text-(--jl-muted) w-14 text-right">{{ volumeLabel }}</span>
                </div>

                <div class="tools">
                    <slot name="actions" />
                    <button
                        type="button"
                        class="tool"
                        :data-active="isVelocityOpen"
                        v-tooltip.bottom="'How loud each step plays'"
                        :aria-pressed="isVelocityOpen"
                        @click="isVelocityOpen = !isVelocityOpen"
                    >
                        <Icon icon="mdi:chart-bar" class="w-4 h-4" />
                        <span>Velocity</span>
                    </button>
                    <button
                        type="button"
                        class="tool"
                        :data-active="isTweakOpen"
                        v-tooltip.bottom="'Sound, pattern tools and effects'"
                        :aria-pressed="isTweakOpen"
                        @click="isTweakOpen = !isTweakOpen"
                    >
                        <Icon icon="mdi:tune-variant" class="w-4 h-4" />
                        <span>Tweak</span>
                    </button>
                </div>
            </div>

            <div class="track-grid">
                <div class="track-grid-slot">
                    <slot />
                    <div v-if="props.hasGrid && isPatternEmpty" class="grid-hint">
                        <span>Tap a step, or drag across a few</span>
                    </div>
                </div>
            </div>

            <div class="track-below">
                <div v-if="isVelocityOpen" class="track-lane">
                    <TrackVolumeSettings :track="props.track" />
                </div>
                <div class="track-lane">
                    <slot name="expanded" />
                </div>

                <div v-if="isTweakOpen" class="tweak">
                    <div class="tweak-tabs">
                        <div class="tweak-tablist" role="tablist" aria-label="Tweak">
                            <button
                                v-for="tab in TWEAK_TABS"
                                :key="tab.key"
                                type="button"
                                class="tweak-tab"
                                role="tab"
                                :data-active="tweakTab === tab.key"
                                :aria-selected="tweakTab === tab.key"
                                @click="tweakTab = tab.key"
                            >
                                <Icon :icon="tab.icon" class="w-4 h-4" />
                                <span>{{ tab.label }}</span>
                            </button>
                        </div>
                        <span class="tweak-note">{{ TWEAK_TABS.find((tab) => tab.key === tweakTab)?.note }}</span>
                    </div>
                    <div class="tweak-body">
                        <div v-show="tweakTab === 'sound'" class="settings" role="tabpanel">
                            <slot name="sound" />
                        </div>
                        <div v-show="tweakTab === 'pattern'" class="settings" role="tabpanel">
                            <TrackPatternSettings :track="props.track" />
                        </div>
                        <div v-show="tweakTab === 'effects'" role="tabpanel">
                            <EffectRack :effects="props.track.effects" />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
