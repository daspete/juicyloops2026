import { Compressor, getContext, Offline, ToneAudioBuffer, ToneBufferSource } from 'tone';
import { STEP_COUNT } from './constants';
import { isEffectNeeded, type EffectKey } from './effects/definitions';
import { isLegacySnapshot, slotsFromLegacy, type EffectsSnapshot, type LegacyEffectsSnapshot } from './effects/effects';
import { Sequencer, type PlaybackMode, type SessionState } from './sequencer';
import { Song } from './song';
import type { TrackState } from './tracks/BaseTrack';
import type { PcmAudio } from './encode';

/**
 * Rendering a session to audio, faster than real time, with Tone's offline context.
 *
 * A second sequencer is built from a captured session inside the offline context, so every synth, sample and
 * effect exists twice for a moment: once for the speakers, once for the file. The live engine is not touched.
 */

/** What to render: the whole arrangement, one container looping, or a single track on its own. */
export type RenderScope =
    | { kind: 'song' }
    | { kind: 'container'; containerId: string; repeats: number }
    | { kind: 'track'; containerId: string; trackId: string; repeats: number };

export interface RenderOptions {
    bpm: number;
    scope: RenderScope;
    /** Seconds of silence after the last step, so releases, delays and reverbs can ring out. */
    tail: number;
    sampleRate?: number;
}

/** Something about the session makes the render pointless, in the words a person needs. */
export class RenderError extends Error {}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a * b) / gcd(a, b);

/** Steps until every pattern of a set of tracks has come round to its start at the same time. */
export const loopLength = (lengths: readonly number[]): number => (lengths.length ? lengths.reduce(lcm, 1) : STEP_COUNT);

/** The seconds one step takes at a tempo: a step is a sixteenth note. */
export const secondsPerStep = (bpm: number): number => 60 / bpm / 4;

/** A microphone track is a sample track that can record; for a render the recording is all that matters. */
const asSampler = (track: TrackState): TrackState => (track.type === 'microphone' ? { ...track, type: 'sampler' } : track);

export interface RenderPlan {
    state: SessionState;
    mode: PlaybackMode;
    /** How many steps to play before the tail. */
    steps: number;
}

/**
 * The session as the offline sequencer gets it: only the containers and tracks the scope needs, no microphone
 * tracks (they need a media stream, which an offline context has not got), and the play mode that fits.
 */
export const planRender = (session: SessionState, scope: RenderScope): RenderPlan => {
    if (scope.kind === 'song') {
        const song = new Song();
        song.restore(session.song);
        if (song.isEmpty) {
            throw new RenderError('The song is empty. Drag a container onto a lane first.');
        }
        return {
            state: { ...session, containers: session.containers.map((container) => ({ ...container, tracks: container.tracks.map(asSampler) })) },
            mode: 'song',
            steps: song.length,
        };
    }

    const container = session.containers.find((candidate) => candidate.id === scope.containerId);
    if (!container) {
        throw new RenderError('That container does not exist any more.');
    }

    let tracks = container.tracks.map(asSampler);
    if (scope.kind === 'track') {
        const track = tracks.find((candidate) => candidate.id === scope.trackId);
        if (!track) {
            throw new RenderError('That track does not exist any more.');
        }
        // A track exported on its own is meant to be heard, muted or not.
        tracks = [{ ...track, isMuted: false }];
    }
    if (!tracks.length) {
        throw new RenderError('The container has no tracks.');
    }

    const repeats = Math.max(1, Math.round(scope.repeats));
    return {
        state: { ...session, containers: [{ ...container, tracks }], currentContainerId: container.id },
        mode: 'loop',
        steps: loopLength(tracks.map((track) => track.length)) * repeats,
    };
};

/** How long a render will be, in seconds. */
export const renderDuration = (plan: RenderPlan, options: Pick<RenderOptions, 'bpm' | 'tail'>): number => plan.steps * secondsPerStep(options.bpm) + Math.max(0, options.tail);

/** Rendered audio: one array of samples per channel, as the encoders take it. */
export class RenderedAudio implements PcmAudio {
    readonly numberOfChannels: number;
    readonly length: number;

    constructor(
        readonly channels: readonly Float32Array[],
        readonly sampleRate: number,
    ) {
        this.numberOfChannels = channels.length;
        this.length = channels[0]?.length ?? 0;
    }

    get duration(): number {
        return this.length / this.sampleRate;
    }

    getChannelData(channel: number): Float32Array {
        return this.channels[channel] ?? new Float32Array(this.length);
    }
}

/**
 * Seconds of silence rendered before the first step. A freshly made compressor starts with its gain closed and
 * opens over its release time, so the first quarter second out of a new context is muffled; live this is over
 * long before anyone presses play, in a render it would hit the first step. Cut off the front again afterwards.
 */
const PRE_ROLL = 0.5;

const compressorLatencies = new Map<number, Promise<number>>();

/**
 * The seconds one native compressor delays a sound. A `DynamicsCompressorNode` looks a few milliseconds ahead,
 * and how far is up to the browser, so it is measured: a short burst through one compressor, once per sample rate.
 * The compressor is neutral (ratio 1) so the burst comes out whole; the look-ahead does not depend on the settings.
 * Not a single-sample click: Firefox's compressor swallows that entirely, which read as no latency at all.
 */
export const compressorLatency = (sampleRate: number): Promise<number> => {
    let pending = compressorLatencies.get(sampleRate);
    if (!pending) {
        pending = Offline(
            () => {
                const burst = ToneAudioBuffer.fromArray(new Float32Array(Math.round(sampleRate * 0.01)).fill(1));
                const source = new ToneBufferSource(burst);
                source.chain(new Compressor({ ratio: 1 }).toDestination());
                source.start(PRE_ROLL);
            },
            PRE_ROLL + 0.25,
            1,
            sampleRate,
        ).then((buffer) => {
            const samples = buffer.getChannelData(0);
            const first = samples.findIndex((sample) => Math.abs(sample) > 1e-6);
            return Math.max(0, first / sampleRate - PRE_ROLL);
        });
        compressorLatencies.set(sampleRate, pending);
    }
    return pending;
};

/** How many look-ahead nodes (a compressor and a limiter are both native compressors) one stored rack builds. */
const dynamicsInRack = (rack: EffectsSnapshot | LegacyEffectsSnapshot): number => {
    const slots = isLegacySnapshot(rack) ? slotsFromLegacy(rack) : rack.slots;
    const stages: EffectKey[] = ['compressor', 'limiter'];
    return slots.filter((slot) => !slot.bypassed && stages.includes(slot.effect) && isEffectNeeded(slot.effect, slot.params)).length;
};

/**
 * The most compressor and limiter nodes a sound passes on its way out, over every track → container bus → master
 * path of a session. Only racks with non-neutral values build these nodes, so a fresh session has just the master's
 * limiter. Muted tracks are not heard and do not count; a container without audible tracks still counts its bus.
 * Counted from the stored values: a compressor that only automation switches on joins mid-render and is not
 * compensated, the same as live.
 */
export const dynamicsInPath = (state: SessionState): number => {
    const master = dynamicsInRack(state.master.effects);
    const paths = state.containers.flatMap((container) => {
        const bus = dynamicsInRack(container.bus.effects);
        const tracks = container.tracks.filter((track) => !track.isMuted);
        return tracks.length ? tracks.map((track) => dynamicsInRack(track.effects) + bus) : [bus];
    });
    return master + Math.max(0, ...paths);
};

/**
 * Renders a captured session to stereo audio, exactly as long as `renderDuration` says: the pre-roll and the signal
 * path's latency are rendered on top and cut off the front, so the first step sits at the very start of the file.
 * Rejects with a `RenderError` when there is nothing to render.
 */
export const renderSession = async (session: SessionState, options: RenderOptions): Promise<RenderedAudio> => {
    const plan = planRender(session, options.scope);
    const duration = renderDuration(plan, options);
    const sampleRate = options.sampleRate ?? getContext().sampleRate;
    // The signal path delays every sound by the look-ahead of the compressors it passes; rendered on top and cut off below.
    const latency = (await compressorLatency(sampleRate)) * dynamicsInPath(plan.state);

    let sequencer: Sequencer | null = null;
    try {
        const rendered = await Offline(
            async (context) => {
                // Note lengths and the step interval come from the transport's tempo, so it is set before anything is scheduled.
                context.transport.bpm.value = options.bpm;
                sequencer = new Sequencer();
                sequencer.setMode(plan.mode);
                sequencer.restore(plan.state);
                await sequencer.whenReady();
                sequencer.start();
                context.transport.start(PRE_ROLL);
                // Half a step after the last one nothing more is scheduled, so the tail is the ring-out of what played,
                // not the start of the next pass of a looping container. Notes already started keep sounding.
                context.transport.stop(PRE_ROLL + (plan.steps - 0.5) * secondsPerStep(options.bpm));
            },
            PRE_ROLL + duration + latency,
            2,
            sampleRate,
        );
        const skip = Math.round((PRE_ROLL + latency) * sampleRate);
        const length = Math.round(duration * sampleRate);
        const channels = Array.from({ length: rendered.numberOfChannels }, (_, channel) => rendered.getChannelData(channel).slice(skip, skip + length));
        return new RenderedAudio(channels, sampleRate);
    } finally {
        (sequencer as Sequencer | null)?.dispose();
    }
};
