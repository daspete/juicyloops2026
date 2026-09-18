<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import { useHistory } from '@/composables/useHistory';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace, type TrackTab } from '@/composables/useWorkspace';
import EffectRack from '../effects/EffectRack.vue';
import TrackPatternSettings from '../tracks/settings/TrackPatternSettings.vue';
import TrackSoundSettings from '../tracks/settings/TrackSoundSettings.vue';
import { TRACK_META } from '../tracks/trackMeta';

/**
 * The track panel (Tweak), docked to the left of the workspace: the sound, pattern tools and effects
 * of the selected track. Nothing else lives here; the container and master channels have the mixer on the right.
 */
const { tracks } = useJuicyLoops();
const { selectedTrack, trackTab, toggleDetail } = useWorkspace();
const { version } = useHistory();

const pick = (tab: TrackTab) => {
    trackTab.value = tab;
};

const TRACK_TABS: readonly { key: TrackTab; label: string; icon: string; note: string }[] = [
    { key: 'sound', label: 'Sound', icon: 'mdi:waveform', note: 'How every step of this track sounds.' },
    { key: 'pattern', label: 'Pattern', icon: 'mdi:dots-grid', note: 'Length and quick edits of the whole loop.' },
    { key: 'effects', label: 'Effects', icon: 'mdi:auto-fix', note: 'In signal order. Drag a chip to reorder the chain.' },
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
    <aside class="dock dock--left" :style="{ '--jl-accent': accent }" aria-label="Selected track">
        <header class="dock-bar">
            <div class="detail-scope" :data-empty="!selectedTrack">
                <span class="track-badge"><Icon :icon="meta?.icon ?? 'mdi:cursor-default-click-outline'" class="w-4 h-4" /></span>
                <span class="detail-scope-name">{{ meta ? `${meta.label} ${trackIndex}` : 'No track' }}</span>
            </div>
            <span class="dock-note">Tweak</span>
            <div class="flex-1"></div>
            <button type="button" class="iconbtn" aria-label="Close track panel" v-tooltip.bottom="'Close'" @click="toggleDetail">
                <Icon icon="mdi:close" class="w-4 h-4" />
            </button>
        </header>

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

        <div class="dock-body">
            <template v-if="selectedTrack">
                <span class="detail-note">{{ note }}</span>
                <div v-show="trackTab === 'sound'" class="settings" role="tabpanel">
                    <TrackSoundSettings :key="selectedTrack.id" :track="selectedTrack" />
                </div>
                <div v-show="trackTab === 'pattern'" class="settings" role="tabpanel">
                    <TrackPatternSettings :track="selectedTrack" />
                </div>
                <div v-show="trackTab === 'effects'" role="tabpanel">
                    <EffectRack :key="`${selectedTrack.id}-${version}`" :effects="selectedTrack.effects" compact />
                </div>
            </template>
            <div v-else class="detail-empty">
                <Icon icon="mdi:cursor-default-click-outline" class="w-6 h-6" />
                <span>{{ note }}</span>
            </div>
        </div>
    </aside>
</template>
