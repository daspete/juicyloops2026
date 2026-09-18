import { engine } from '@/juicyloops/engine';
import { DEFAULT_BPM, STEP_COUNT } from '@/juicyloops/constants';
import type { PlaybackMode } from '@/juicyloops/sequencer';
import type { Song } from '@/juicyloops/song';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import type { TrackOf, TrackType } from '@/juicyloops/tracks/registry';
import { computed, ref, watch, type Ref } from 'vue';

export const MIN_BPM = 10;
export const MAX_BPM = 900;

/*
 * Module level state: there is exactly one engine, so there is exactly one UI state for it.
 * Everything below runs once, no matter how many components call `useJuicyLoops()`.
 */
const bpm = ref(DEFAULT_BPM);
/** The play position: inside the song in song mode, a running count in loop mode. */
const currentStep = ref(0);
/** The play position inside one section of `STEP_COUNT` steps, what the ruler of the track editor shows. */
const currentTick = computed(() => currentStep.value % STEP_COUNT);
const isPlaying = ref(false);
const mode: Ref<PlaybackMode> = ref('loop');
/*
 * The same objects the sequencer reads from; the UI edits them through these reactive proxies.
 * Tracks are not stored separately: they are whatever the current container holds.
 */
const containers = ref(engine.containers) as Ref<TrackContainer[]>;
const currentContainerId = ref(engine.currentContainer.id);
const currentContainer = computed(() => containers.value.find((container) => container.id === currentContainerId.value) ?? containers.value[0]!);
const tracks = computed(() => currentContainer.value.tracks);
const song = ref(engine.song) as Ref<Song>;

watch(bpm, (value) => engine.setBpm(value));
watch(mode, (value) => engine.setMode(value));
engine.onStep((step) => {
    // Steps are scheduled ahead of time, so a few still arrive after stop; they must not undo the reset.
    if (isPlaying.value) {
        currentStep.value = step;
    }
});

/** Where the playhead sits inside one track's own pattern. */
const trackStep = (track: BaseTrack): number => track.stepOf(currentStep.value);

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
    currentStep.value = 0;
};

const setMode = (value: PlaybackMode): void => {
    mode.value = value;
};

/** Jumps to a step of the song. Starts playback when stopped, so a click on the timeline always makes sound. */
const playFrom = (step: number): void => {
    engine.seekToStep(step);
    currentStep.value = step;
    if (!isPlaying.value) {
        play();
    }
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

/* ---- containers ---- */

const selectContainer = (id: string): void => {
    engine.setCurrentContainer(id);
    currentContainerId.value = engine.currentContainer.id;
};

const addContainer = (): TrackContainer => {
    const container = engine.addContainer();
    selectContainer(container.id);
    return container;
};

const removeContainer = (id: string): void => {
    engine.removeContainer(id);
    currentContainerId.value = engine.currentContainer.id;
};

const duplicateContainer = async (id: string): Promise<TrackContainer | null> => {
    const copy = await engine.duplicateContainer(id);
    if (copy) {
        selectContainer(copy.id);
    }
    return copy;
};

const renameContainer = (id: string, name: string): void => {
    const container = containers.value.find((candidate) => candidate.id === id);
    const trimmed = name.trim();
    if (container && trimmed) {
        container.name = trimmed;
    }
};

/* ---- tracks of the current container ---- */

const addTrack = <T extends TrackType>(type: T): TrackOf<T> => currentContainer.value.addTrack(type);

const removeTrack = (id: string): void => currentContainer.value.removeTrack(id);

const duplicateTrack = (id: string): Promise<BaseTrack | null> => currentContainer.value.duplicateTrack(id);

export const useJuicyLoops = () => ({
    engine,
    bpm,
    setBpm,
    tapTempo,
    currentTick,
    currentStep,
    trackStep,
    isPlaying,
    play,
    stop,
    togglePlay,
    mode,
    setMode,
    song,
    playFrom,
    containers,
    currentContainer,
    selectContainer,
    addContainer,
    removeContainer,
    duplicateContainer,
    renameContainer,
    tracks,
    addTrack,
    removeTrack,
    duplicateTrack,
});
