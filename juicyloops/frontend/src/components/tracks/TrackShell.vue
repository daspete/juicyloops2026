<script setup lang="ts">
import { useContainerView } from '@/composables/useContainerView';
import { useExport } from '@/composables/useExport';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useMidi } from '@/composables/useMidi';
import { useWorkspace } from '@/composables/useWorkspace';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';
import { Slider, useConfirm } from 'primevue';
import { computed, ref } from 'vue';
import SongMenu, { type SongMenuItem } from '../song/SongMenu.vue';
import TrackAutomationLanes from './settings/TrackAutomationLanes.vue';
import TrackVolumeSettings from './settings/TrackVolumeSettings.vue';
import { TRACK_META } from './trackMeta';

/**
 * Everything every track row has in common: the coloured channel head and the lanes under the step grid.
 * The head has three rows: who the track is (name, length, the ⋯ menu with duplicate, export and remove),
 * its mix (mute, volume) and its tools (icon toggles for what opens under the grid, then Tweak).
 * and the lanes that can open under the step grid (velocity, automation, piano roll, waveform).
 * Clicking the head selects the track; its sound, pattern tools and effects then live in the Tweak panel.
 * The row is a two-row grid: head and step grid side by side, everything that opens below them across the full width.
 *
 * Slots:
 *  - `actions`  extra tool toggles, before the shared ones (an icon and a label; the label is read out, not shown)
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
const { container } = useContainerView();
const { openDialog: openExport } = useExport();
const { selectedTrack, selectTrack, openTrack, isTrackShowing, toggleDetail, isPro } = useWorkspace();
const confirm = useConfirm();
const { isAnyArmed } = useMidi();

const meta = computed(() => TRACK_META[props.track.type]);
const isSelected = computed(() => selectedTrack.value?.id === props.track.id);
const isTweakOpen = computed(() => isTrackShowing(props.track.id));
/** The selected track always plays MIDI; with no track armed it is also the one a take records into: its arm button shows that, dimmer than a real arm. */
const isArmedImplicitly = computed(() => !isAnyArmed.value && isSelected.value);
const armHint = computed(() => {
    if (props.track.isArmed) {
        return 'Armed: your MIDI keyboard plays this track and recording goes into it. Click to disarm';
    }
    return isArmedImplicitly.value
        ? 'Selected and no track is armed: your MIDI keyboard plays this track and recording goes into it. Click to arm it'
        : 'Arm: play and record this track from a MIDI keyboard (several can be armed; the selected track always plays)';
});

const isVelocityOpen = ref(false);
/** The automation lanes under the grid. A track that already has lanes (a duplicate) starts with them open. */
const isAutomationOpen = ref(props.track.automation.lanes.length > 0);
const showsAutomation = computed(() => isPro.value && isAutomationOpen.value);

const isPatternEmpty = computed(() => !props.track.notes.length);

const volumeLabel = computed(() => `${props.track.volume > 0 ? '+' : ''}${props.track.volume.toFixed(1)} dB`);

const select = () => selectTrack(props.track.id);

const toggleTweak = () => {
    if (isTweakOpen.value) {
        toggleDetail();
    } else {
        openTrack(props.track.id);
    }
};

const exportTrack = () => openExport({ scope: { kind: 'track', containerId: container.value.id, trackId: props.track.id, repeats: 1 } });

/* The track menu: behind the ⋯ button, and on a right-click anywhere on the head. */
const menu = ref<{ x: number; y: number; anchor: HTMLElement } | null>(null);

const openMenu = (event: MouseEvent) => {
    const head = (event.currentTarget as HTMLElement).closest('.track-head') as HTMLElement;
    if (event.type === 'click') {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        menu.value = { x: rect.left, y: rect.bottom + 4, anchor: head };
    } else {
        menu.value = { x: event.clientX, y: event.clientY, anchor: head };
    }
};

/* The menu closes before its action runs, so the confirmation's anchor is taken while it is still open. */
const menuItems = computed<SongMenuItem[]>(() => {
    const anchor = menu.value?.anchor;
    return [
        { label: 'Duplicate track', icon: 'mdi:content-copy', action: () => void duplicateTrack(props.track.id, container.value) },
        { label: 'Export as audio', icon: 'mdi:export-variant', action: exportTrack },
        {},
        { label: 'Remove track', icon: 'mdi:trash-can-outline', danger: true, action: () => confirmRemove(anchor) },
    ];
});

const confirmRemove = (target?: HTMLElement) => {
    confirm.require({
        target,
        message: `Remove this ${meta.value.label} track?`,
        acceptLabel: 'Remove',
        rejectLabel: 'Keep',
        acceptProps: { severity: 'danger', size: 'small' },
        rejectProps: { text: true, size: 'small' },
        accept: () => removeTrack(props.track.id, container.value),
    });
};
</script>

<template>
    <div class="track" :class="{ 'track--muted': props.track.isMuted, 'track--selected': isSelected }" :style="{ '--jl-accent': meta.accent }">
        <div class="track-inner">
            <div class="track-head" @pointerdown="select" @contextmenu.prevent="openMenu">
                <div class="track-title">
                    <span class="track-badge"><Icon :icon="meta.icon" class="w-3.5 h-3.5" /></span>
                    <span class="track-name">
                        {{ meta.label }}<span class="track-index">{{ props.trackIndex + 1 }}</span>
                    </span>
                    <span class="track-length" v-tooltip.bottom="'Steps in this loop. Change it under Tweak → Pattern.'">{{ props.track.length }}</span>
                    <button
                        type="button"
                        class="iconbtn iconbtn--tiny track-more"
                        :data-active="!!menu"
                        aria-label="Track menu"
                        aria-haspopup="menu"
                        v-tooltip.bottom="'Duplicate, export, remove'"
                        @click="openMenu"
                    >
                        <Icon icon="mdi:dots-horizontal" class="w-4 h-4" />
                    </button>
                </div>

                <div class="track-mix">
                    <button
                        type="button"
                        class="mutebtn armbtn"
                        :data-active="props.track.isArmed"
                        :data-implicit="isArmedImplicitly"
                        v-tooltip.bottom="armHint"
                        :aria-label="props.track.isArmed ? 'Disarm for MIDI' : 'Arm for MIDI'"
                        :aria-pressed="props.track.isArmed"
                        @click="props.track.setArmed(!props.track.isArmed)"
                    >
                        <Icon icon="mdi:record-circle-outline" class="w-3.5 h-3.5" />
                    </button>
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

                <div class="track-toolbar">
                    <div class="tools" role="group" aria-label="Show under the steps">
                        <slot name="actions" />
                        <button
                            type="button"
                            class="tool"
                            :data-active="isVelocityOpen"
                            v-tooltip.bottom="'Velocity: how loud each step plays'"
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
                            v-tooltip.bottom="'Automate: draw any value of this track over the loop'"
                            :aria-pressed="showsAutomation"
                            @click="isAutomationOpen = !isAutomationOpen"
                        >
                            <Icon icon="mdi:chart-bell-curve-cumulative" class="w-4 h-4" />
                            <span>Automate</span>
                            <b v-if="props.track.automation.lanes.length" class="tool-count">{{ props.track.automation.lanes.length }}</b>
                        </button>
                    </div>
                    <button
                        type="button"
                        class="tool tool--tweak"
                        :data-active="isTweakOpen"
                        v-tooltip.bottom="'Sound, pattern tools and effects'"
                        :aria-pressed="isTweakOpen"
                        @click="toggleTweak"
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
                <div v-if="showsAutomation" class="track-lane">
                    <TrackAutomationLanes :track="props.track" @close="isAutomationOpen = false" />
                </div>
                <div class="track-lane">
                    <slot name="expanded" />
                </div>
            </div>
        </div>
    </div>

    <Teleport to="body">
        <SongMenu v-if="menu" :items="menuItems" :x="menu.x" :y="menu.y" :title="`${meta.label} ${props.trackIndex + 1}`" @close="menu = null" />
    </Teleport>
</template>
