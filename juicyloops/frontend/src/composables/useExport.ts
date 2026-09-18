import { computed, ref } from 'vue';
import { engine } from '@/juicyloops/engine';
import { DEFAULT_MP3_BITRATE, encodeAudio, type ExportFormat } from '@/juicyloops/encode';
import { planRender, renderDuration, RenderError, renderSession, type RenderScope } from '@/juicyloops/render';
import { downloadBlob, safeFileName } from './download';
import { useJuicyLoops } from './useJuicyLoops';
import { useSession } from './useSession';

/**
 * Bouncing the song, a container or one track to a WAV or MP3 file.
 *
 * The render happens offline (faster than real time) from a snapshot of the session, so nothing has to play
 * out loud, and the live engine keeps going as it was. Module level state: there is one export at a time.
 */

export interface ExportSettings {
    scope: RenderScope;
    format: ExportFormat;
    /** Seconds of silence after the last step for tails to ring out. */
    tail: number;
    /** MP3 only. */
    bitrate: number;
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

const { bpm, stop, containers } = useJuicyLoops();
const session = useSession();

const isExporting = ref(false);
/** Set while the export dialog is open, with what it was opened for. */
const request = ref<ExportRequest | null>(null);
const isDialogOpen = computed(() => request.value !== null);

const openDialog = (preset: ExportRequest = {}): void => {
    request.value = preset;
};

const closeDialog = (): void => {
    request.value = null;
};

/** How long the file would be, or the reason the render cannot happen. */
const preview = (scope: RenderScope, tail: number): { seconds: number } | { error: string } => {
    try {
        const plan = planRender(engine.capture(), scope);
        return { seconds: renderDuration(plan, { bpm: bpm.value, tail }) };
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
    if (error instanceof RenderError) {
        return error.message;
    }
    console.error('Export failed', error);
    return 'The audio could not be rendered.';
};

/** Renders and downloads. Playback stops first: the render borrows Tone's global context for a moment. */
const exportAudio = async (settings: ExportSettings): Promise<ExportResult> => {
    if (isExporting.value) {
        return { ok: false, error: 'An export is already running.' };
    }
    isExporting.value = true;
    try {
        stop();
        const state = engine.capture();
        const seconds = renderDuration(planRender(state, settings.scope), { bpm: bpm.value, tail: settings.tail });
        if (seconds > MAX_RENDER_SECONDS) {
            throw new RenderError(`That would be ${Math.round(seconds / 60)} minutes of audio; the browser cannot hold more than ${MAX_RENDER_SECONDS / 60}.`);
        }
        const audio = await renderSession(state, { bpm: bpm.value, scope: settings.scope, tail: settings.tail });
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

export const useExport = () => ({ isExporting, isDialogOpen, request, openDialog, closeDialog, preview, exportAudio });
