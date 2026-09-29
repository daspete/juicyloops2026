import { ref, watch, type Ref } from 'vue';

/**
 * The tool every velocity lane draws with, shared like a DAW's tool bar: pick Line in one lane and every lane draws
 * lines. Holding Alt switches to Line for as long as it is held.
 *
 * - draw:  sweep across the stems, they follow the pointer
 * - line:  drag from one point to another, the stems in between take a straight ramp
 * - curve: the same, then a handle on the ramp bends it
 */
export type VelocityTool = 'draw' | 'line' | 'curve';

export const VELOCITY_TOOLS: readonly { key: VelocityTool; label: string; icon: string; hint: string }[] = [
    { key: 'draw', label: 'Draw', icon: 'mdi:draw', hint: 'Draw: sweep across the stems. Grab a stem head to move it (Shift: fine)' },
    { key: 'line', label: 'Line', icon: 'mdi:vector-line', hint: 'Line: drag from one point to another for a straight ramp (or hold Alt)' },
    { key: 'curve', label: 'Curve', icon: 'mdi:vector-curve', hint: 'Curve: drag a ramp, then bend it by its handle' },
];

const tool = ref<VelocityTool>('draw');

export const useVelocityTool = () => ({ tool });

/* ---- lane height, remembered per kind of lane ---- */

const HEIGHT_KEY = 'juicyloops:velocity-height:';

const readHeight = (kind: string, fallback: number): number => {
    try {
        const value = Number(localStorage.getItem(HEIGHT_KEY + kind));
        return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch {
        return fallback;
    }
};

const heights = new Map<string, Ref<number>>();

/** The height of a kind of lane (`steps`, `roll`), shared by every lane of that kind and kept across visits. */
export const useVelocityHeight = (kind: string, fallback: number): Ref<number> => {
    let height = heights.get(kind);
    if (!height) {
        const created = ref(readHeight(kind, fallback));
        watch(created, (value) => {
            try {
                localStorage.setItem(HEIGHT_KEY + kind, String(Math.round(value)));
            } catch {
                /* the height simply does not persist */
            }
        });
        heights.set(kind, created);
        height = created;
    }
    return height;
};
