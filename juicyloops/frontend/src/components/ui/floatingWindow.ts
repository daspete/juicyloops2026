/**
 * Geometry of the floating windows (container windows, piano rolls): where one sits, how big it is,
 * and which is in front. Positions and sizes are pixels inside the area the window floats in.
 */
export interface FloatingWindowState {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Stacking order; higher is in front. */
    z: number;
    isMaximized: boolean;
}

export interface WindowArea {
    width: number;
    height: number;
}

export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 180;

let topZ = 0;

/** A stacking order above every window so far. Shared by all windows, so the one clicked last is always in front. */
export const nextZ = (): number => ++topZ;

export const isOnTop = (state: FloatingWindowState): boolean => state.z === topZ;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value));

/** Keeps a window inside its area: never larger than it, never off its edges, so the title bar stays reachable. */
export const fitWindow = (state: FloatingWindowState, area: WindowArea): void => {
    state.width = clamp(state.width, MIN_WINDOW_WIDTH, area.width);
    state.height = clamp(state.height, MIN_WINDOW_HEIGHT, area.height);
    state.x = clamp(state.x, 0, area.width - state.width);
    state.y = clamp(state.y, 0, area.height - state.height);
};

/** A window of the wanted size (shrunk to fit), centred in the area and set `offset` px down and right. */
export const centredWindow = (area: WindowArea, width: number, height: number, offset = 0, top?: number): FloatingWindowState => {
    const state: FloatingWindowState = {
        width: Math.min(width, area.width - 24),
        height: Math.min(height, area.height - (top ?? 0) - 12),
        x: 0,
        y: 0,
        z: nextZ(),
        isMaximized: false,
    };
    state.x = (area.width - state.width) / 2 + offset;
    state.y = (top ?? (area.height - state.height) / 2) + offset;
    fitWindow(state, area);
    return state;
};
