import { computed, ref, watch } from 'vue';
import { useJuicyLoops } from './useJuicyLoops';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';

/**
 * What the workspace looks like and looks at, the way a DAW keeps one thing selected.
 *
 * Quick mode is the track view and nothing else: add tracks, paint steps, shape their sound.
 * Pro mode adds containers, the song arranger, the mixer for the container and master channels, and automation.
 * The selected track is what the detail panel at the bottom shows.
 *
 * Module level state, so every component sees the same selection.
 */
export type WorkspaceMode = 'quick' | 'pro';
export type TrackTab = 'sound' | 'pattern' | 'effects';

const MODE_KEY = 'juicyloops:mode';

const readStoredMode = (): WorkspaceMode | null => {
    try {
        const value = localStorage.getItem(MODE_KEY);
        return value === 'quick' || value === 'pro' ? value : null;
    } catch {
        return null;
    }
};

const { tracks } = useJuicyLoops();

const mode = ref<WorkspaceMode>(readStoredMode() ?? 'quick');
const isPro = computed(() => mode.value === 'pro');

/** The mixer dock on the right: the container channel and the master. Pro only. */
const isMixerOpen = ref(false);

const selectedTrackId = ref<string | null>(null);
const trackTab = ref<TrackTab>('sound');
const isDetailOpen = ref(true);

watch(mode, (value) => {
    if (value === 'quick') {
        isMixerOpen.value = false;
    }
    try {
        localStorage.setItem(MODE_KEY, value);
    } catch {
        /* private mode or blocked storage: the choice simply does not persist */
    }
});

const setMode = (value: WorkspaceMode): void => {
    mode.value = value;
};

/** The selected track, falling back to the first one of the current container when the selection is gone. */
const selectedTrack = computed<BaseTrack | null>(() => tracks.value.find((track) => track.id === selectedTrackId.value) ?? tracks.value[0] ?? null);

const selectTrack = (id: string, tab?: TrackTab): void => {
    selectedTrackId.value = id;
    if (tab) {
        trackTab.value = tab;
    }
};

/** Selects the track and makes sure the detail panel shows it. */
const openTrack = (id: string, tab?: TrackTab): void => {
    selectTrack(id, tab);
    isDetailOpen.value = true;
};

const toggleDetail = (): void => {
    isDetailOpen.value = !isDetailOpen.value;
};

/** True when the detail panel is open and showing exactly this track. */
const isTrackShowing = (trackId: string): boolean => isDetailOpen.value && selectedTrack.value?.id === trackId;

const openMixer = (): void => {
    isMixerOpen.value = true;
};

const toggleMixer = (): void => {
    isMixerOpen.value = !isMixerOpen.value;
};

export const useWorkspace = () => ({
    mode,
    isPro,
    setMode,
    isMixerOpen,
    openMixer,
    toggleMixer,
    selectedTrack,
    trackTab,
    isDetailOpen,
    selectTrack,
    openTrack,
    toggleDetail,
    isTrackShowing,
});
