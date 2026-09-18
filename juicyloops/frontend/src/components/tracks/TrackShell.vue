<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';
import { Slider, useConfirm } from 'primevue';
import { computed, ref } from 'vue';
import TrackAutomationLanes from './settings/TrackAutomationLanes.vue';
import TrackVolumeSettings from './settings/TrackVolumeSettings.vue';
import { TRACK_META } from './trackMeta';

/**
 * Everything every track row has in common: the coloured channel head (name, mute, volume, tools)
 * and the lanes that can open under the step grid (velocity, automation, piano roll, waveform).
 * Clicking the head selects the track; its sound, pattern tools and effects then live in the detail panel below the workspace.
 * The row is a two-row grid: head and step grid side by side, everything that opens below them across the full width.
 *
 * Slots:
 *  - `actions`  extra tool buttons (before the shared ones)
 *  - default    main content (usually the tick grid)
 *  - `expanded` content shown below the grid (piano roll, waveform, ...)
 */
const props = defineProps<{
    track: BaseTrack;
    trackIndex: number;
    /** True when the default slot shows the step grid, so an empty grid can get a first-use hint. */
    hasGrid?: boolean;
}>();

const { removeTrack, duplicateTrack } = useJuicyLoops();
const { selectedTrack, selectTrack, openTrack, isTrackShowing, toggleDetail, isPro } = useWorkspace();
const confirm = useConfirm();

const meta = computed(() => TRACK_META[props.track.type]);
const isSelected = computed(() => selectedTrack.value?.id === props.track.id);
const isTweakOpen = computed(() => isTrackShowing(props.track.id));

const isVelocityOpen = ref(false);
/** The automation lanes under the grid. A track that already has lanes (a duplicate) starts with them open. */
const isAutomationOpen = ref(props.track.automation.lanes.length > 0);
const showsAutomation = computed(() => isPro.value && isAutomationOpen.value);

const isPatternEmpty = computed(() => !props.track.ticks.some((tick) => tick.isActive));

const volumeLabel = computed(() => `${props.track.volume > 0 ? '+' : ''}${props.track.volume.toFixed(1)} dB`);

const select = () => selectTrack(props.track.id);

const toggleTweak = () => {
    if (isTweakOpen.value) {
        toggleDetail();
    } else {
        openTrack(props.track.id);
    }
};

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
    <div class="track" :class="{ 'track--muted': props.track.isMuted, 'track--selected': isSelected }" :style="{ '--jl-accent': meta.accent }">
        <div class="track-inner">
            <div class="track-head" @pointerdown="select">
                <div class="track-title">
                    <span class="track-badge"><Icon :icon="meta.icon" class="w-4 h-4" /></span>
                    <span class="track-name">{{ meta.label }}</span>
                    <span class="track-index">{{ props.trackIndex + 1 }}</span>
                    <span class="track-length" v-tooltip.bottom="'Steps in this loop. Change it under Pattern in the panel below.'">{{ props.track.length }}</span>
                    <div class="flex-1"></div>
                    <span class="track-actions">
                        <button type="button" class="iconbtn iconbtn--tiny" aria-label="Duplicate track" v-tooltip.bottom="'Duplicate track'" @click="duplicateTrack(props.track.id)">
                            <Icon icon="mdi:content-copy" class="w-3.5 h-3.5" />
                        </button>
                        <button type="button" class="iconbtn iconbtn--tiny iconbtn--danger" aria-label="Remove track" v-tooltip.bottom="'Remove track'" @click="confirmRemove">
                            <Icon icon="mdi:trash-can-outline" class="w-3.5 h-3.5" />
                        </button>
                    </span>
                </div>

                <div class="track-mix">
                    <button
                        type="button"
                        class="mutebtn"
                        :data-active="props.track.isMuted"
                        v-tooltip.bottom="props.track.isMuted ? 'Unmute' : 'Mute'"
                        :aria-label="props.track.isMuted ? 'Unmute' : 'Mute'"
                        :aria-pressed="props.track.isMuted"
                        @click="props.track.toggleMute()"
                    >
                        M
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
                    <span class="track-db">{{ volumeLabel }}</span>
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
                        v-if="isPro"
                        type="button"
                        class="tool"
                        :data-active="showsAutomation"
                        v-tooltip.bottom="'Draw any value of this track over the loop'"
                        :aria-pressed="showsAutomation"
                        @click="isAutomationOpen = !isAutomationOpen"
                    >
                        <Icon icon="mdi:chart-bell-curve-cumulative" class="w-4 h-4" />
                        <span>Automate</span>
                        <span v-if="props.track.automation.lanes.length" class="tool-count">{{ props.track.automation.lanes.length }}</span>
                    </button>
                    <button type="button" class="tool" :data-active="isTweakOpen" v-tooltip.bottom="'Sound, pattern tools and effects'" :aria-pressed="isTweakOpen" @click="toggleTweak">
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
                <div v-if="showsAutomation" class="track-lane">
                    <TrackAutomationLanes :track="props.track" @close="isAutomationOpen = false" />
                </div>
                <div class="track-lane">
                    <slot name="expanded" />
                </div>
            </div>
        </div>
    </div>
</template>
