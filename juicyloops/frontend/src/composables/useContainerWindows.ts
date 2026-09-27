import { computed, ref } from 'vue';
import { useJuicyLoops } from './useJuicyLoops';

/**
 * The container windows of the song view: floating editors, one per container, that show its tracks while the
 * song plays. Any number can be open; the one clicked last is on top and its container is the current one, so the
 * track panel (Tweak) and the mixer's container channel follow whatever window you work in.
 *
 * Module level state, so the windows are still there after a trip to the track view and back.
 * Positions and sizes are pixels inside the song view.
 */
export interface ContainerWindowState {
    containerId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    z: number;
    isMaximized: boolean;
}

export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 180;
const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 440;
/** How far each new window is set off from the one opened before it. */
const CASCADE = 28;
const MARGIN = 12;
/** Below this width (px) windows open maximized. */
const COMPACT_WIDTH = 640;
/** Room left above the first window, so the song toolbar stays reachable. */
const TOP = 48;

const { containers, selectContainer } = useJuicyLoops();

const windows = ref<ContainerWindowState[]>([]);
/** The window the keyboard belongs to: the one last clicked, until a click lands outside every window. */
const activeId = ref<string | null>(null);
let topZ = 0;

/** Windows of containers that were removed (or undone away) are closed. */
const openWindows = computed(() => windows.value.filter((win) => containers.value.some((container) => container.id === win.containerId)));

const find = (containerId: string) => windows.value.find((win) => win.containerId === containerId);

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value));

/** Keeps a window inside the area: at least partly on screen, its title bar always reachable. */
const fit = (win: ContainerWindowState, area: { width: number; height: number }): void => {
    win.width = clamp(win.width, MIN_WINDOW_WIDTH, area.width);
    win.height = clamp(win.height, MIN_WINDOW_HEIGHT, area.height);
    win.x = clamp(win.x, 0, area.width - win.width);
    win.y = clamp(win.y, 0, area.height - win.height);
};

/** Brings a window to the front and makes its container the current one. */
const focus = (containerId: string): void => {
    const win = find(containerId);
    if (!win) {
        return;
    }
    if (win.z !== topZ) {
        win.z = ++topZ;
    }
    activeId.value = containerId;
    selectContainer(containerId);
};

/** Opens the window of a container, or brings it forward when it is open already. */
const open = (containerId: string, area: { width: number; height: number }): void => {
    if (!find(containerId)) {
        const offset = (openWindows.value.length % 6) * CASCADE;
        const win: ContainerWindowState = {
            containerId,
            width: Math.min(DEFAULT_WIDTH, area.width - 2 * MARGIN),
            height: Math.min(DEFAULT_HEIGHT, area.height - TOP - MARGIN),
            x: 0,
            y: TOP + offset,
            z: ++topZ,
            // On a phone there is no room to float: the window fills the song view.
            isMaximized: area.width < COMPACT_WIDTH,
        };
        win.x = Math.max(MARGIN, area.width - win.width - MARGIN * 2) / 2 + offset;
        fit(win, area);
        windows.value.push(win);
    }
    focus(containerId);
};

const close = (containerId: string): void => {
    windows.value = windows.value.filter((win) => win.containerId !== containerId);
    if (activeId.value === containerId) {
        activeId.value = null;
    }
};

const toggleMaximize = (containerId: string): void => {
    const win = find(containerId);
    if (win) {
        win.isMaximized = !win.isMaximized;
    }
};

const setActive = (containerId: string | null): void => {
    activeId.value = containerId;
};

export const useContainerWindows = () => ({
    windows: openWindows,
    activeId: computed(() => activeId.value),
    isOpen: (containerId: string) => !!find(containerId),
    open,
    close,
    focus,
    fit,
    toggleMaximize,
    setActive,
});
