import { getContext } from 'tone';
import { computed, nextTick, ref } from 'vue';
import { engine } from '@/juicyloops/engine';
import { DEFAULT_MP3_BITRATE, encodeAudio, type ExportFormat } from '@/juicyloops/encode';
import { isLiveRenderSupported, liveOnlyPlugins, LiveRecorder, mixChangesFor, RecordingCancelled, type MixChange } from '@/juicyloops/liveRender';
import {
    compressorLatency,
    dynamicsInPath,
    planRender,
    renderDuration,
    RenderError,
    renderSession,
    secondsPerStep,
    type RenderedAudio,
    type RenderPlan,
    type RenderScope,
} from '@/juicyloops/render';
import type { SessionState } from '@/juicyloops/sequencer';
import { downloadBlob, safeFileName } from './download';
import { useJuicyLoops } from './useJuicyLoops';
import { useSession } from './useSession';

/**
 * Bouncing the song, a container or one track to a WAV or MP3 file.
 *
 * Two ways to render. Offline (fast) renders from a snapshot of the session, faster than real time, so nothing has to
 * play out loud and the live engine keeps going as it was. Real time plays the scope once on the live engine and
 * records the master (`liveRender.ts`): it takes as long as the audio and is heard meanwhile, but it catches plugins
 * that are silent offline. Module level state: there is one export at a time.
 */

/** `offline` renders faster than real time; `live` records the live engine while it plays. */
export type ExportMethod = 'offline' | 'live';

export interface ExportSettings {
    scope: RenderScope;
    format: ExportFormat;
    /** Seconds of silence after the last step for tails to ring out. */
    tail: number;
    /** MP3 only. */
    bitrate: number;
    /** Offline when left out. */
    method?: ExportMethod;
}

export const DEFAULT_TAIL = 2;
export const MAX_TAIL = 10;
export const REPEAT_OPTIONS: readonly number[] = [1, 2, 4, 8];

/** Renders longer than this are refused: a browser tab cannot hold the samples. */
export const MAX_RENDER_SECONDS = 20 * 60;

export type ExportResult = { ok: true; fileName: string; seconds: number } | { ok: false; error: string };

/** What a track export button asks the dialog to start with. */
export interface ExportRequest {
    scope?: RenderScope;
}

const { bpm, stop, play, containers, currentContainer, selectContainer, mode, setMode, songCue, songLoop, onBeforeStop } = useJuicyLoops();
const session = useSession();

const isExporting = ref(false);
/** While a real-time export records: seconds heard so far and in all. Null otherwise. */
const progress = ref<{ elapsed: number; total: number } | null>(null);
/** Stops the running real-time export; null when none runs. */
let cancelLive: (() => void) | null = null;
/** Set while the export dialog is open, with what it was opened for. */
const request = ref<ExportRequest | null>(null);
const isDialogOpen = computed(() => request.value !== null);

const openDialog = (preset: ExportRequest = {}): void => {
    request.value = preset;
};

const closeDialog = (): void => {
    request.value = null;
};

/**
 * How long the file would be and which plugins in the scope only sound in a real-time export, or the reason the
 * render cannot happen.
 */
const preview = (scope: RenderScope, tail: number): { seconds: number; liveOnly: string[] } | { error: string } => {
    try {
        const plan = planRender(engine.capture(), scope);
        return { seconds: renderDuration(plan, { bpm: bpm.value, tail }), liveOnly: liveOnlyPlugins(plan.state) };
    } catch (error) {
        return { error: error instanceof RenderError ? error.message : 'This cannot be rendered.' };
    }
};

/** A name that says what the file holds: the session, and the container or track when it is not the whole song. */
const fileNameFor = (scope: RenderScope, format: ExportFormat): string => {
    const base = safeFileName(session.name.value);
    if (scope.kind === 'song') {
        return `${base}.${format}`;
    }
    const container = containers.value.find((candidate) => candidate.id === scope.containerId);
    const label = container ? safeFileName(container.name) : 'container';
    if (scope.kind === 'container') {
        return `${base} - ${label}.${format}`;
    }
    const index = container?.tracks.findIndex((track) => track.id === scope.trackId) ?? -1;
    const track = container?.tracks[index];
    const trackLabel = track ? `${track.type} ${index + 1}` : 'track';
    return `${base} - ${label} - ${trackLabel}.${format}`;
};

const describe = (error: unknown): string => {
    if (error instanceof RenderError || error instanceof RecordingCancelled) {
        return error.message;
    }
    console.error('Export failed', error);
    return 'The audio could not be rendered.';
};

/** Sets mute and solo switches through the reactive containers and tracks, so the mixer strips and the solo logic follow. */
const applyMix = (changes: readonly MixChange[]): void => {
    for (const change of changes) {
        const container = containers.value.find((candidate) => candidate.id === change.containerId);
        if (!container) {
            continue;
        }
        if (!change.trackId) {
            if (change.isSolo !== undefined) {
                container.bus.setSolo(change.isSolo);
            }
            continue;
        }
        const track = container.tracks.find((candidate) => candidate.id === change.trackId);
        if (track && change.isSolo !== undefined) {
            track.isSolo = change.isSolo;
        }
        if (track && change.isMuted !== undefined) {
            track.isMuted = change.isMuted;
        }
    }
};

/**
 * Seconds between arming the recorder and the first step, on top of the transport's look-ahead: time for the command
 * to reach the audio thread and for the first step to be scheduled.
 */
const LIVE_LEAD = 0.15;

/** Seconds past the planned end after which a recording that never finished counts as failed. */
const LIVE_GRACE = 3;

/**
 * Plays the plan once on the live engine and records the master, to the frame: the recorder is armed for the very
 * frame the transport starts on (plus the look-ahead of the compressors in the path, as the offline render cuts it).
 * The transport stops half a step after the last step, so the tail rings out without the loop coming round again.
 *
 * Mode, current container, song cue, song loop region and mute/solo are borrowed and put back as they were,
 * whether the recording finishes, is cancelled (Cancel, or the stop button) or fails.
 */
const recordLive = async (state: SessionState, plan: RenderPlan, scope: RenderScope, seconds: number): Promise<RenderedAudio> => {
    const context = getContext();
    if (!isLiveRenderSupported(context)) {
        throw new RenderError('Real-time export needs a secure (https) page. Use the fast export instead.');
    }
    await engine.initialize();
    const latency = (await compressorLatency(context.sampleRate)) * dynamicsInPath(plan.state);
    const recorder = await LiveRecorder.create(context, engine.master.meterSource);

    const saved = { mode: mode.value, containerId: currentContainer.value.id, songCue: songCue.value, songLoop: songLoop.value ? { ...songLoop.value } : null };
    const mix = mixChangesFor(state, scope);
    let removeStopHook = (): void => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
        applyMix(mix.apply);
        setMode(plan.mode);
        songLoop.value = null;
        songCue.value = 0;
        if (plan.mode === 'loop') {
            selectContainer(plan.state.currentContainerId);
        }
        // The mode, loop region and solo reach the engine through watchers.
        await nextTick();

        const startTime = context.currentTime + context.lookAhead + LIVE_LEAD;
        const recording = recorder.record({ startTime: startTime + latency, seconds });
        cancelLive = () => recorder.cancel();
        removeStopHook = onBeforeStop(() => recorder.cancel());
        progress.value = { elapsed: 0, total: seconds };
        timer = setInterval(() => {
            const elapsed = context.currentTime - startTime;
            progress.value = { elapsed: Math.min(seconds, Math.max(0, elapsed)), total: seconds };
            if (elapsed > seconds + latency + LIVE_GRACE) {
                recorder.cancel(new RenderError('The recording did not finish. Try again.'));
            }
        }, 100);

        play(startTime);
        engine.transport.stop(startTime + (plan.steps - 0.5) * secondsPerStep(bpm.value));
        return await recording;
    } finally {
        clearInterval(timer);
        progress.value = null;
        cancelLive = null;
        removeStopHook();
        recorder.dispose();
        applyMix(mix.undo);
        setMode(saved.mode);
        if (containers.value.some((container) => container.id === saved.containerId)) {
            selectContainer(saved.containerId);
        }
        songLoop.value = saved.songLoop;
        songCue.value = saved.songCue;
        // Last, so the playhead comes to rest where the restored mode and cue put it.
        stop();
    }
};

/** Stops a running real-time export; it resolves as cancelled and everything is put back. */
const cancelExport = (): void => {
    cancelLive?.();
};

/** Renders and downloads. Playback stops first: the offline render borrows Tone's global context for a moment. */
const exportAudio = async (settings: ExportSettings): Promise<ExportResult> => {
    if (isExporting.value) {
        return { ok: false, error: 'An export is already running.' };
    }
    isExporting.value = true;
    try {
        stop();
        await engine.refreshPluginStates();
        const state = engine.capture();
        const plan = planRender(state, settings.scope);
        const seconds = renderDuration(plan, { bpm: bpm.value, tail: settings.tail });
        if (seconds > MAX_RENDER_SECONDS) {
            throw new RenderError(`That would be ${Math.round(seconds / 60)} minutes of audio; the browser cannot hold more than ${MAX_RENDER_SECONDS / 60}.`);
        }
        const audio =
            settings.method === 'live'
                ? await recordLive(state, plan, settings.scope, seconds)
                : await renderSession(state, { bpm: bpm.value, scope: settings.scope, tail: settings.tail });
        const blob = await encodeAudio(audio, settings.format, settings.bitrate || DEFAULT_MP3_BITRATE);
        const fileName = fileNameFor(settings.scope, settings.format);
        downloadBlob(blob, fileName);
        return { ok: true, fileName, seconds: audio.duration };
    } catch (error) {
        return { ok: false, error: describe(error) };
    } finally {
        isExporting.value = false;
    }
};

export const useExport = () => ({ isExporting, progress, isDialogOpen, request, openDialog, closeDialog, preview, exportAudio, cancelExport });
