<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace, type TrackTab } from '@/composables/useWorkspace';
import EffectRack from '../effects/EffectRack.vue';
import TrackPatternSettings from '../tracks/settings/TrackPatternSettings.vue';
import TrackSoundSettings from '../tracks/settings/TrackSoundSettings.vue';
import { TRACK_META } from '../tracks/trackMeta';

/**
 * The panel docked to the bottom of the workspace, like the device view of a DAW:
 * the sound, pattern tools and effects of the selected track. Nothing else lives here;
 * the container and master channels have the mixer on the right.
 */
const { tracks } = useJuicyLoops();
const { selectedTrack, trackTab, isDetailOpen, toggleDetail } = useWorkspace();

/** Picking a page in a folded panel unfolds it: nobody clicks a tab to see nothing. */
const pick = (tab: TrackTab) => {
    trackTab.value = tab;
    isDetailOpen.value = true;
};

const TRACK_TABS: readonly { key: TrackTab; label: string; icon: string; note: string }[] = [
    { key: 'sound', label: 'Sound', icon: 'mdi:waveform', note: 'How every step of this track sounds' },
    { key: 'pattern', label: 'Pattern', icon: 'mdi:dots-grid', note: 'Length and quick edits of the whole loop' },
    { key: 'effects', label: 'Effects', icon: 'mdi:auto-fix', note: 'In signal order, drag a chip to reorder' },
];

const meta = computed(() => (selectedTrack.value ? TRACK_META[selectedTrack.value.type] : null));
const trackIndex = computed(() => (selectedTrack.value ? tracks.value.indexOf(selectedTrack.value) + 1 : 0));
const accent = computed(() => meta.value?.accent ?? 'var(--jl-brand)');

const note = computed(() => {
    if (!selectedTrack.value) {
        return 'The sound, pattern tools and effects of the selected track show up here.';
    }
    return TRACK_TABS.find((tab) => tab.key === trackTab.value)?.note ?? '';
});
</script>

<template>
    <section class="detail" :data-open="isDetailOpen" :style="{ '--jl-accent': accent }" aria-label="Selected track">
        <header class="detail-bar">
            <button type="button" class="detail-toggle" :aria-expanded="isDetailOpen" :aria-label="isDetailOpen ? 'Collapse detail panel' : 'Expand detail panel'" @click="toggleDetail">
                <Icon :icon="isDetailOpen ? 'mdi:chevron-down' : 'mdi:chevron-up'" class="w-4 h-4" />
            </button>

            <div class="detail-scope" :data-empty="!selectedTrack">
                <span class="track-badge"><Icon :icon="meta?.icon ?? 'mdi:cursor-default-click-outline'" class="w-4 h-4" /></span>
                <span class="detail-scope-name">{{ meta ? `${meta.label} ${trackIndex}` : 'No track' }}</span>
            </div>

            <div v-if="selectedTrack" class="detail-tabs" role="tablist" aria-label="Track pages">
                <button
                    v-for="tab in TRACK_TABS"
                    :key="tab.key"
                    type="button"
                    class="detail-tab"
                    role="tab"
                    :data-active="trackTab === tab.key"
                    :aria-selected="trackTab === tab.key"
                    @click="pick(tab.key)"
                >
                    <Icon :icon="tab.icon" class="w-4 h-4" />
                    <span>{{ tab.label }}</span>
                </button>
            </div>

            <span class="detail-note">{{ note }}</span>
        </header>

        <div v-show="isDetailOpen" class="detail-body">
            <template v-if="selectedTrack">
                <div v-show="trackTab === 'sound'" class="settings" role="tabpanel">
                    <TrackSoundSettings :key="selectedTrack.id" :track="selectedTrack" />
                </div>
                <div v-show="trackTab === 'pattern'" class="settings" role="tabpanel">
                    <TrackPatternSettings :track="selectedTrack" />
                </div>
                <div v-show="trackTab === 'effects'" role="tabpanel">
                    <EffectRack :key="selectedTrack.id" :effects="selectedTrack.effects" />
                </div>
            </template>
            <div v-else class="detail-empty">
                <Icon icon="mdi:cursor-default-click-outline" class="w-5 h-5" />
                <span>Add a track, then select it here to shape its sound.</span>
            </div>
        </div>
    </section>
</template>
