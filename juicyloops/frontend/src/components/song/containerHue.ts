import type { TrackContainer } from '@/juicyloops/trackContainer';

const CLIP_HUES = [275, 330, 25, 95, 190, 50, 150, 230];

/** One hue per container, so its clips, its picker entry and its window look the same everywhere. */
export const containerHue = (containers: readonly TrackContainer[], id: string): number =>
    CLIP_HUES[
        Math.max(
            0,
            containers.findIndex((container) => container.id === id),
        ) % CLIP_HUES.length
    ]!;
