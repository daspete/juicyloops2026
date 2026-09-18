import { engine } from '@/juicyloops/engine';
import { DEFAULT_BPM } from '@/juicyloops/constants';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import type { TrackOf, TrackType } from '@/juicyloops/tracks/registry';
import { ref, watch, type Ref } from 'vue';

export const MIN_BPM = 10;
export const MAX_BPM = 900;

/*
 * Module level state: there is exactly one engine, so there is exactly one UI state for it.
 * Everything below runs once, no matter how many components call `useJuicyLoops()`.
 */
const bpm = ref(DEFAULT_BPM);
const currentTick = ref(0);
const isPlaying = ref(false);
const tracks: Ref<BaseTrack[]> = ref([]);

watch(bpm, (value) => engine.setBpm(value));
engine.onStep((step) => (currentTick.value = step));

const clampBpm = (value: number): number => Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(value)));

const setBpm = (value: number): void => {
    if (Number.isFinite(value)) {
        bpm.value = clampBpm(value);
    }
};

const play = (): void => {
    engine.play();
    isPlaying.value = true;
};

const stop = (): void => {
    engine.stop();
    isPlaying.value = false;
    currentTick.value = 0;
};

const togglePlay = (): void => (isPlaying.value ? stop() : play());

/* Tap tempo: the average gap between the last few taps. A pause of two seconds starts a new measurement. */
const TAP_RESET_MS = 2000;
const TAP_WINDOW = 8;
let taps: number[] = [];

const tapTempo = (): void => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1]! > TAP_RESET_MS) {
        taps = [];
    }

    taps.push(now);
    taps = taps.slice(-TAP_WINDOW);

    if (taps.length < 2) {
        return;
    }

    const averageInterval = (taps[taps.length - 1]! - taps[0]!) / (taps.length - 1);
    setBpm(60000 / averageInterval);
};

const addTrack = <T extends TrackType>(type: T): TrackOf<T> => {
    const track = engine.addTrack(type);
    tracks.value.push(track);
    return track;
};

const removeTrack = (id: string): void => {
    engine.removeTrack(id);
    tracks.value = tracks.value.filter((track) => track.id !== id);
};

const duplicateTrack = async (id: string): Promise<BaseTrack | null> => {
    const copy = await engine.duplicateTrack(id);
    if (copy) {
        tracks.value.push(copy);
    }
    return copy;
};

export const useJuicyLoops = () => ({
    engine,
    bpm,
    setBpm,
    tapTempo,
    currentTick,
    isPlaying,
    play,
    stop,
    togglePlay,
    tracks,
    addTrack,
    removeTrack,
    duplicateTrack,
});
