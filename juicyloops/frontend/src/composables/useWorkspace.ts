import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { sameTarget, type AutomationTarget } from '@/juicyloops/automation';
import { useJuicyLoops } from './useJuicyLoops';
import { useViewport } from './useViewport';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';

/**
 * What the workspace looks like and looks at, the way a DAW keeps one thing selected.
 *
 * The layout has fixed places: the sample browser on the left, the Inspector on the right (settings of the selected
 * channel), and the bottom dock with two tabs: Devices (the selected channel's instrument and effect chain) and Mixer
 * (every channel as a strip). One selection drives all of them: the selected channel, a track, a container channel,
 * a return or the master. Selecting a track in the editor selects its channel.
 *
 * Quick mode is the track view with a simple mixer and macro devices; Pro adds containers, the song arranger,
 * returns and automation.
 *
 * Module level state, so every component sees the same selection.
 */
export type WorkspaceMode = 'quick' | 'pro';
export type DockTab = 'devices' | 'mixer';
/** How much of each device the rack shows: a few big knobs, or every parameter. */
export type DeviceFace = 'macro' | 'full';

const MODE_KEY = 'juicyloops:mode';
const BROWSER_KEY = 'juicyloops:browser';
const DOCK_KEY = 'juicyloops:dock';
const INSPECTOR_KEY = 'juicyloops:inspector';

const read = (key: string): string | null => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const write = (key: string, value: string): void => {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* private mode or blocked storage: the choice simply does not persist */
    }
};

/** A ref that is stored in localStorage whenever it changes. */
const persisted = <T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string = String): Ref<T> => {
    const value = ref(parse(read(key))) as Ref<T>;
    watch(value, (next) => write(key, serialize(next)), { deep: true });
    return value;
};

const { tracks, currentContainer } = useJuicyLoops();
const { isPhone } = useViewport();

const mode = ref<WorkspaceMode>(read(MODE_KEY) === 'pro' ? 'pro' : read(MODE_KEY) === 'quick' ? 'quick' : 'quick');
const isPro = computed(() => mode.value === 'pro');

watch(mode, (value) => write(MODE_KEY, value));

const setMode = (value: WorkspaceMode): void => {
    mode.value = value;
};

/** The sample browser on the far left: folders of samples to audition and add as tracks. Stays open across visits. */
const isBrowserOpen = persisted(BROWSER_KEY, (raw) => raw === 'open', (open) => (open ? 'open' : 'closed'));

/* ---- the bottom dock ---- */

interface DockState {
    open: boolean;
    tab: DockTab;
    /** Height in px while not maximised. */
    height: number;
    maximized: boolean;
    face: DeviceFace;
    /** Mixer strips drawn narrow (fader and meter only). */
    narrow: boolean;
    /** Container groups folded down to their channel strip, by container id. */
    folded: string[];
}

export const DOCK_MIN_HEIGHT = 160;
export const DOCK_DEFAULT_HEIGHT = 400;

const parseDock = (raw: string | null): DockState => {
    const fallback: DockState = { open: false, tab: 'devices', height: DOCK_DEFAULT_HEIGHT, maximized: false, face: 'macro', narrow: false, folded: [] };
    try {
        const stored = raw ? (JSON.parse(raw) as Partial<DockState>) : {};
        return {
            ...fallback,
            ...stored,
            tab: stored.tab === 'mixer' ? 'mixer' : 'devices',
            face: stored.face === 'full' ? 'full' : 'macro',
            folded: Array.isArray(stored.folded) ? stored.folded.filter((id) => typeof id === 'string') : [],
        };
    } catch {
        return fallback;
    }
};

const dock = persisted<DockState>(DOCK_KEY, parseDock, (value) => JSON.stringify(value));

const isDockOpen = computed(() => dock.value.open);
const dockTab = computed(() => dock.value.tab);

/** Opens the dock on a tab. */
const openDock = (tab: DockTab): void => {
    dock.value = { ...dock.value, open: true, tab };
};

/** Opens the dock on a tab, or closes it when that tab is already showing. */
const toggleDock = (tab: DockTab = dock.value.tab): void => {
    if (dock.value.open && dock.value.tab === tab) {
        dock.value = { ...dock.value, open: false, maximized: false };
    } else {
        openDock(tab);
    }
};

const closeDock = (): void => {
    dock.value = { ...dock.value, open: false, maximized: false };
};

const setDockHeight = (height: number): void => {
    dock.value = { ...dock.value, height: Math.max(DOCK_MIN_HEIGHT, Math.round(height)) };
};

const toggleDockMaximized = (): void => {
    dock.value = { ...dock.value, maximized: !dock.value.maximized, open: true };
};

const setDeviceFace = (face: DeviceFace): void => {
    dock.value = { ...dock.value, face };
};

const toggleNarrow = (): void => {
    dock.value = { ...dock.value, narrow: !dock.value.narrow };
};

const isFolded = (containerId: string): boolean => dock.value.folded.includes(containerId);

const toggleFolded = (containerId: string): void => {
    const folded = dock.value.folded;
    dock.value = { ...dock.value, folded: folded.includes(containerId) ? folded.filter((id) => id !== containerId) : [...folded, containerId] };
};

/* The mixer and the devices, as the older panel toggles call them. */
const isMixerOpen = computed(() => dock.value.open && dock.value.tab === 'mixer');
const isDetailOpen = computed(() => dock.value.open && dock.value.tab === 'devices');
const openMixer = (): void => openDock('mixer');
const toggleMixer = (): void => toggleDock('mixer');
const toggleDetail = (): void => toggleDock('devices');

/* ---- the Inspector ---- */

const isInspectorOpen = persisted(INSPECTOR_KEY, (raw) => raw === 'open', (open) => (open ? 'open' : 'closed'));

const toggleInspector = (): void => {
    isInspectorOpen.value = !isInspectorOpen.value;
};

/* ---- the selection ---- */

const selectedTrackId = ref<string | null>(null);

/** The selected track, falling back to the first one of the current container when the selection is gone. */
const selectedTrack = computed<BaseTrack | null>(() => tracks.value.find((track) => track.id === selectedTrackId.value) ?? tracks.value[0] ?? null);

/**
 * A channel picked in the mixer (a container channel, a return, the master, or a track of any container). Null means
 * the selection follows the selected track of the editor.
 */
const pickedChannel = shallowRef<AutomationTarget | null>(null);

/** The channel the Inspector and the device rack show. */
const selectedChannel = computed<AutomationTarget | null>(() => {
    if (pickedChannel.value) {
        return pickedChannel.value;
    }
    const track = selectedTrack.value;
    return track ? { kind: 'track', containerId: currentContainer.value.id, trackId: track.id } : null;
});

/**
 * Opens the Inspector for a newly selected track, so its pattern tools are at hand. Not on a phone: there the Inspector
 * covers the whole stage and would hide the track you just tapped.
 */
const revealInspector = (): void => {
    if (!isPhone.value) {
        isInspectorOpen.value = true;
    }
};

/** Selects a track of the current container; its channel becomes the selected channel and the Inspector opens. */
const selectTrack = (id: string): void => {
    selectedTrackId.value = id;
    pickedChannel.value = null;
    revealInspector();
};

/** Selects any channel. A track of the current container is also selected in the editor. */
const selectChannel = (target: AutomationTarget): void => {
    if (target.kind === 'track' && target.containerId === currentContainer.value.id) {
        selectTrack(target.trackId);
        return;
    }
    pickedChannel.value = { ...target };
    if (target.kind === 'track') {
        revealInspector();
    }
};

const isChannelSelected = (target: AutomationTarget): boolean => !!selectedChannel.value && sameTarget(selectedChannel.value, target);

/** Selects the track and shows its devices (the Tweak button of a track). */
const openTrack = (id: string): void => {
    selectTrack(id);
    openDock('devices');
};

/** True when the device rack is open and showing exactly this track. */
const isTrackShowing = (trackId: string): boolean => {
    const channel = selectedChannel.value;
    return isDetailOpen.value && channel?.kind === 'track' && channel.trackId === trackId;
};

/* Switching containers drops a picked track of another container, so the selection follows the editor again. */
watch(
    () => currentContainer.value.id,
    () => {
        if (pickedChannel.value?.kind === 'track') {
            pickedChannel.value = null;
        }
    },
);

export const useWorkspace = () => ({
    mode,
    isPro,
    setMode,
    isBrowserOpen,
    toggleBrowser: (): void => {
        isBrowserOpen.value = !isBrowserOpen.value;
    },
    dock,
    isDockOpen,
    dockTab,
    openDock,
    toggleDock,
    closeDock,
    setDockHeight,
    toggleDockMaximized,
    setDeviceFace,
    toggleNarrow,
    isFolded,
    toggleFolded,
    isMixerOpen,
    openMixer,
    toggleMixer,
    isDetailOpen,
    toggleDetail,
    isInspectorOpen,
    toggleInspector,
    selectedTrack,
    selectTrack,
    selectedChannel,
    selectChannel,
    isChannelSelected,
    openTrack,
    isTrackShowing,
});
