import { computed, ref } from 'vue';
import { centredWindow, fitWindow, isOnTop, nextZ, type FloatingWindowState, type WindowArea } from '@/components/ui/floatingWindow';
import { useJuicyLoops } from './useJuicyLoops';

/**
 * The container windows of the song view: floating editors, one per container, that show its tracks while the
 * song plays. Any number can be open; the one clicked last is on top and its container is the current one, so the
 * track panel (Tweak) and the mixer's container channel follow whatever window you work in.
 *
 * Module level state, so the windows are still there after a trip to the track view and back.
 * Positions and sizes are pixels inside the song view.
 */
export interface ContainerWindowState extends FloatingWindowState {
    containerId: string;
}

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 440;
/** How far each new window is set off from the one opened before it. */
const CASCADE = 28;
/** Below this width (px) windows open maximized. */
const COMPACT_WIDTH = 640;
/** Room left above the first window, so the song toolbar stays reachable. */
const TOP = 48;

const { containers, selectContainer } = useJuicyLoops();

const windows = ref<ContainerWindowState[]>([]);
/** The window the keyboard belongs to: the one last clicked, until a click lands outside every floating window. */
const activeId = ref<string | null>(null);

/** Windows of containers that were removed (or undone away) are closed. */
const openWindows = computed(() => windows.value.filter((win) => containers.value.some((container) => container.id === win.containerId)));

const find = (containerId: string) => windows.value.find((win) => win.containerId === containerId);

/** Brings a window to the front and makes its container the current one. */
const focus = (containerId: string): void => {
    const win = find(containerId);
    if (!win) {
        return;
    }
    if (!isOnTop(win)) {
        win.z = nextZ();
    }
    activeId.value = containerId;
    selectContainer(containerId);
};

/** Opens the window of a container, or brings it forward when it is open already. */
const open = (containerId: string, area: WindowArea): void => {
    if (!find(containerId)) {
        const offset = (openWindows.value.length % 6) * CASCADE;
        const win: ContainerWindowState = { containerId, ...centredWindow(area, DEFAULT_WIDTH, DEFAULT_HEIGHT, offset, TOP) };
        // On a phone there is no room to float: the window fills the song view.
        win.isMaximized = area.width < COMPACT_WIDTH;
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
    fit: fitWindow,
    setActive,
});
