import { MicrophoneTrack } from './MicrophoneTrack';
import { SamplerTrack } from './SamplerTrack';
import { SynthTrack } from './SynthTrack';

/**
 * Single place that knows which track types exist.
 * Register a new track class here and it becomes available to the engine and (via `TRACK_TYPES`) to the UI.
 */
export const TRACK_CLASSES = {
    synth: SynthTrack,
    sampler: SamplerTrack,
    microphone: MicrophoneTrack,
} as const;

export type TrackType = keyof typeof TRACK_CLASSES;

/** The concrete track class for a type, e.g. `TrackOf<'synth'>` is `SynthTrack`. */
export type TrackOf<T extends TrackType> = InstanceType<(typeof TRACK_CLASSES)[T]>;

export type AnyTrack = TrackOf<TrackType>;

export const TRACK_TYPES = Object.keys(TRACK_CLASSES) as TrackType[];

/** A new track, with a given id when one is brought back from history. */
export const createTrack = <T extends TrackType>(type: T, id?: string): TrackOf<T> => new TRACK_CLASSES[type](id) as TrackOf<T>;
