import { engine } from '@/juicyloops/engine';
import type { Automatable, AutomationTarget } from '@/juicyloops/automation';
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

/** The song position marker: where song playback starts, and where the playhead rests while stopped. */
const songCue = ref(0);
/** The loop region of the song timeline, null to play the whole song. */
const songLoop = ref<{ start: number; end: number } | null>(null);

watch(bpm, (value) => engine.setBpm(value));
watch(mode, (value) => {
    engine.setMode(value);
    if (!isPlaying.value) {
        currentStep.value = value === 'song' ? songCue.value : 0;
    }
});
watch(songLoop, (value) => engine.setLoop(value ? { ...value } : null), { deep: true });
engine.onStep((step) => {
    // Steps are scheduled ahead of time, so a few still arrive after stop; they must not undo the reset.
    if (isPlaying.value) {
        currentStep.value = step;
    }
});

const clampBpm = (value: number): number => Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(value)));

const setBpm = (value: number): void => {
    if (Number.isFinite(value)) {
        bpm.value = clampBpm(value);
    }
};

/** Song playback starts at the position marker, loop playback at the top. */
const play = (): void => {
    if (mode.value === 'song') {
        engine.seekToStep(songCue.value);
        currentStep.value = songCue.value;
    }
    engine.play();
    isPlaying.value = true;
};

/** Stopping puts the playhead back where playback started, like a DAW does. */
const stop = (): void => {
    engine.stop();
    isPlaying.value = false;
    currentStep.value = mode.value === 'song' ? songCue.value : 0;
};

const setMode = (value: PlaybackMode): void => {
    mode.value = value;
};

/** Jumps to a step of the song. Starts playback when stopped, so a click on the timeline always makes sound. */
const playFrom = (step: number): void => {
    if (mode.value === 'song') {
        songCue.value = step;
    }
    engine.seekToStep(step);
    currentStep.value = step;
    if (!isPlaying.value) {
        play();
    }
};

/** Moves the song position marker. While playing, playback jumps there right away. */
const cueSong = (step: number): void => {
    songCue.value = Math.max(0, Math.round(step));
    if (isPlaying.value) {
        engine.seekToStep(songCue.value);
    }
    currentStep.value = songCue.value;
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

/* ---- tracks, of the current container unless another one is named ---- */

const addTrack = <T extends TrackType>(type: T, container: TrackContainer = currentContainer.value): TrackOf<T> => container.addTrack(type);

const removeTrack = (id: string, container: TrackContainer = currentContainer.value): void => {
    container.removeTrack(id);
    song.value.removeTrack(id);
};

/** What a song automation lane drives, or undefined when it was deleted. */
const resolveTarget = (target: AutomationTarget): (Automatable & { settle(key: string): void }) | undefined => engine.resolveTarget(target);

const duplicateTrack = (id: string, container: TrackContainer = currentContainer.value): Promise<BaseTrack | null> => container.duplicateTrack(id);

export const useJuicyLoops = () => ({
    engine,
    bpm,
    setBpm,
    tapTempo,
    currentTick,
    currentStep,
    isPlaying,
    play,
    stop,
    togglePlay,
    mode,
    setMode,
    song,
    playFrom,
    songCue,
    songLoop,
    cueSong,
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
    resolveTarget,
});
