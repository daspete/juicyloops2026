import { Gain, ToneBufferSource, getContext } from 'tone';
import { ref, watch } from 'vue';
import { decodeBlob } from '@/juicyloops/audio';

/**
 * Auditioning samples in the sample browser: one sample at a time, straight to the speakers (past the mixer, so no
 * effect of the song colours it), cut off after `maxSeconds` with a short fade.
 *
 * Module level state: there is one preview, whichever component starts it.
 */

const SETTINGS_KEY = 'juicyloops:preview';

export const MIN_PREVIEW_SECONDS = 0.5;
export const MAX_PREVIEW_SECONDS = 30;
const DEFAULT_PREVIEW_SECONDS = 4;
const DEFAULT_PREVIEW_VOLUME = 0.8;

/** Fades (seconds) at both ends, so a cut-off preview does not click. */
const FADE_IN = 0.003;
const FADE_OUT = 0.04;

/** Decoded samples kept for playing them again; long ones are not worth the memory. */
const CACHE_SIZE = 24;
const CACHE_MAX_SECONDS = 60;

interface PreviewSettings {
    maxSeconds: number;
    volume: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readSettings = (): PreviewSettings => {
    const fallback = { maxSeconds: DEFAULT_PREVIEW_SECONDS, volume: DEFAULT_PREVIEW_VOLUME };
    try {
        const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<PreviewSettings> | null;
        return {
            maxSeconds: Number.isFinite(stored?.maxSeconds) ? clamp(stored!.maxSeconds!, MIN_PREVIEW_SECONDS, MAX_PREVIEW_SECONDS) : fallback.maxSeconds,
            volume: Number.isFinite(stored?.volume) ? clamp(stored!.volume!, 0, 1) : fallback.volume,
        };
    } catch {
        return fallback;
    }
};

const settings = readSettings();
/** The longest a preview plays (seconds); shorter samples play out. */
const maxSeconds = ref(settings.maxSeconds);
/** Linear level of the preview, 0 to 1. */
const volume = ref(settings.volume);

/** Which sample plays (its browser id), or is being decoded to play; null when quiet. */
const playingId = ref<string | null>(null);
/** How long the current preview lasts (seconds), for its progress bar; 0 while it is still decoding. */
const playingSeconds = ref(0);
/** Bumped with every preview started, so the progress bar restarts even for the same sample. */
const playCount = ref(0);

watch([maxSeconds, volume], ([seconds, level]) => {
    output?.gain.rampTo(level, 0.05);
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ maxSeconds: seconds, volume: level }));
    } catch {
        /* private mode or blocked storage: the settings simply do not persist */
    }
});

/* Tone nodes live outside Vue's reactivity on purpose (see the proxy trap on SampleTrack.voices). */
let output: Gain | null = null;
let source: ToneBufferSource | null = null;
let endTimer: ReturnType<typeof setTimeout> | null = null;
/** Increases with every start and stop; a decode that finishes after a newer request is dropped. */
let generation = 0;

const cache = new Map<string, AudioBuffer>();

const remember = (key: string, buffer: AudioBuffer) => {
    if (buffer.duration > CACHE_MAX_SECONDS) {
        return;
    }
    cache.delete(key);
    cache.set(key, buffer);
    while (cache.size > CACHE_SIZE) {
        cache.delete(cache.keys().next().value!);
    }
};

const decode = async (key: string, file: Blob): Promise<AudioBuffer> => {
    const cached = cache.get(key);
    if (cached) {
        // Refresh its place: the least recently played sample goes first.
        remember(key, cached);
        return cached;
    }
    const buffer = await decodeBlob(file);
    remember(key, buffer);
    return buffer;
};

const release = () => {
    if (endTimer) {
        clearTimeout(endTimer);
        endTimer = null;
    }
    if (source) {
        const ending = source;
        source = null;
        try {
            // Fades out over `fadeOut`; Tone disposes a finished source by itself.
            ending.stop();
        } catch {
            /* already stopped */
        }
    }
};

/** Stops whatever preview plays. */
const stop = (): void => {
    generation++;
    release();
    playingId.value = null;
    playingSeconds.value = 0;
};

/**
 * Plays a sample, stopping the one before. `id` tells samples apart (the progress bar and the cache use it).
 * Resolves once it plays, or rejects when the file cannot be decoded.
 */
const play = async (id: string, file: File): Promise<void> => {
    stop();
    const mine = generation;
    playingId.value = id;

    let buffer: AudioBuffer;
    try {
        buffer = await decode(`${id}:${file.size}:${file.lastModified}`, file);
    } catch (error) {
        if (mine === generation) {
            stop();
        }
        throw error;
    }
    if (mine !== generation) {
        return;
    }

    const context = getContext();
    if (context.state !== 'running') {
        await context.resume();
    }
    if (mine !== generation) {
        return;
    }

    output ??= new Gain(volume.value).toDestination();
    const seconds = Math.min(buffer.duration, maxSeconds.value);
    const cutOff = seconds < buffer.duration;
    // The fade out starts at the stop time, so a cut-off preview stops a fade early to end on time. A stop by hand fades too.
    source = new ToneBufferSource({ url: buffer, fadeIn: FADE_IN, fadeOut: FADE_OUT }).connect(output);
    source.start(context.now(), 0, cutOff ? Math.max(0, seconds - FADE_OUT) : undefined);

    playingSeconds.value = seconds;
    playCount.value++;
    endTimer = setTimeout(() => {
        if (mine === generation) {
            source = null;
            endTimer = null;
            playingId.value = null;
            playingSeconds.value = 0;
        }
    }, seconds * 1000);
};

/** Plays the sample, or stops it when it is the one playing. */
const toggle = (id: string, file: () => Promise<File>): Promise<void> => {
    if (playingId.value === id) {
        stop();
        return Promise.resolve();
    }
    stop();
    const mine = generation;
    playingId.value = id;
    return file().then(
        (resolved) => (mine === generation ? play(id, resolved) : undefined),
        (error: unknown) => {
            if (mine === generation) {
                stop();
            }
            throw error;
        },
    );
};

export const useSamplePreview = () => ({
    maxSeconds,
    volume,
    playingId,
    playingSeconds,
    playCount,
    play,
    toggle,
    stop,
});
