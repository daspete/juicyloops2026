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
        <div class="flex gap-3 p-2">
            <div class="track-head shrink-0 flex flex-col gap-1 p-1">
                <div class="flex items-center gap-2 h-7 pl-1">
                    <span class="track-dot"></span>
                    <Icon :icon="meta.icon" class="w-4 h-4" />
                    <span class="font-semibold">{{ meta.label }}</span>
                    <span class="font-mono text-xs text-(--jl-muted)">{{ props.trackIndex + 1 }}</span>
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

                <div class="flex items-center gap-0.5 h-7">
                    <slot name="actions" />
                    <button
                        type="button"
                        class="iconbtn"
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
                        class="iconbtn"
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

            <div class="flex-1 min-w-0 flex flex-col gap-2">
                <div class="relative">
                    <slot />
                    <div v-if="props.hasGrid && isPatternEmpty" class="grid-hint">
                        <span>Tap a step, or drag across a few</span>
                    </div>
                </div>
                <TrackVolumeSettings v-if="isVelocityOpen" :track="props.track" />
                <slot name="expanded" />

                <div v-if="isTweakOpen" class="tweak">
                    <div class="tweak-row">
                        <section class="panel">
                            <h3 class="panel-title"><Icon icon="mdi:waveform" class="w-3.5 h-3.5" /> Sound</h3>
                            <div class="panel-body">
                                <slot name="sound" />
                            </div>
                        </section>
                        <section class="panel">
                            <h3 class="panel-title"><Icon icon="mdi:dots-grid" class="w-3.5 h-3.5" /> Pattern</h3>
                            <div class="panel-body">
                                <TrackPatternSettings :track="props.track" />
                            </div>
                        </section>
                    </div>
                    <section class="panel">
                        <h3 class="panel-title"><Icon icon="mdi:auto-fix" class="w-3.5 h-3.5" /> Effects <span class="panel-note">in signal order, drag a chip to reorder</span></h3>
                        <div class="panel-body">
                            <EffectRack :track="props.track" />
                        </div>
                    </section>
                </div>
            </div>
        </div>
    </div>
</template>
