import { Gain, ToneBufferSource } from 'tone';
import { markRaw } from 'vue';
import { decodeBlob } from '../audio';
import { sampleJobs } from '../dsp/sampleJobs';
import { SAMPLE_ROOT_NOTE, semitonesBetween } from '../notes';
import type { PatternNote } from '../notes/Note';
import { evenCuts, normalizeCuts, sliceRanges, type OnsetOptions, type SliceRange } from '../slices';
import { semitoneRatio } from '../stretch';
import type { LegacyTrackState } from '../notes/migrate';
import { BaseTrack, type TrackSnapshot, type TrackState } from './BaseTrack';

export interface SampleTrackSnapshot extends TrackSnapshot {
    sampleName: string | null;
    sampleStartTime: number;
    sampleDuration: number;
    pitch: number;
    speed: number;
    cuts: number[];
    /** Missing in snapshots from before the setting; one-shot then. */
    gate?: boolean;
    buffer: ArrayBuffer | null;
}

/** History keeps the sample by reference: the blob is never copied, only pointed at. */
export interface SampleTrackState extends TrackState {
    sampleBlob: Blob | null;
    sampleName: string | null;
    sampleStartTime: number;
    sampleDuration: number;
    isReversed: boolean;
    /** Missing in states saved before pitch, speed and slices existed. */
    pitch?: number;
    speed?: number;
    cuts?: number[];
    gate?: boolean;
}

/** Semitones the pitch knob reaches either way. */
export const SAMPLE_PITCH_RANGE = 24;
export const MIN_SAMPLE_SPEED = 0.25;
export const MAX_SAMPLE_SPEED = 4;

/** Fade (seconds) at both ends of every played slice, so cutting into a waveform does not click. */
const VOICE_FADE = 0.003;

/** How long (ms) pitch, speed or trim have to stay put before the stretched audio is worked out again. */
const RENDER_DELAY = 150;

/** The audio a track plays from: the sample, or the stretched part of it. */
interface Rendition {
    buffer: AudioBuffer;
    /** The same, backwards; made the first time a reversed step plays. */
    reversed: AudioBuffer | null;
    /** Where (seconds in the sample) the buffer starts. */
    origin: number;
    /** How much longer the buffer is than the audio it came from. */
    stretch: number;
    /** The pitch (semitones) the buffer was made for. */
    pitch: number;
}

/** What a rendition is made from; a finished job is only used while the track still asks for the same. */
interface RenditionPlan {
    buffer: AudioBuffer;
    /** The region, in sample frames. */
    from: number;
    to: number;
    stretch: number;
    pitch: number;
}

/** Stretch factors this close to 1 play the sample untouched. */
const IDENTITY_EPSILON = 1e-4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A track that plays a slice of an audio buffer for every note of its pattern.
 * Where the buffer comes from (a file, the microphone, ...) is up to the subclass.
 *
 * Pitch and speed are independent: the played region is time-stretched so that, played back at the pitch
 * ratio, it lasts exactly as long as the speed says. With neither turned, the sample plays untouched.
 *
 * Every note starts a voice of its own, the note's velocity sets its level and its pitch decides what it plays: a
 * sample that is not sliced is played higher or lower by the distance from `SAMPLE_ROOT_NOTE`; a sliced one plays
 * the slice that sits on that key (the root is the first slice, every semitone up the next).
 *
 * One-shot (the default) plays the slice out whatever the note's length; `gate` stops the voice with a short fade
 * at the end of the note. A long slice rings on under the next note, unless the track cuts notes: then a new note
 * stops whatever is still sounding (notes starting at the same time, a chord, all play).
 */
export abstract class SampleTrack extends BaseTrack {
    /** Where every voice goes; the effect chain starts here. */
    private readonly input = markRaw(new Gain());

    /** The raw audio the sample was decoded from. Kept for the waveform view, serialization and duplication. */
    sampleBlob: Blob | null = null;
    sampleName: string | null = null;
    hasSample = false;

    /** Start offset (seconds) and length (seconds) of the region that is played. */
    sampleStartTime = 0;
    sampleDuration = 0;

    isReversed = false;

    /** Semitones up (or down, negative), without changing the length. */
    pitch = 0;
    /** Playback speed factor, without changing the pitch. */
    speed = 1;

    /** Cut points (seconds in the sample) that split the region into slices. See `slices.ts`. */
    cuts: number[] = [];

    /** Gate: a voice stops (with a short fade) at the end of its note. Off (one-shot) plays every slice out. */
    gate = false;

    /** The decoded sample. */
    private buffer: AudioBuffer | null = null;
    private rendition: Rendition | null = null;
    private renderTimer: ReturnType<typeof setTimeout> | null = null;
    /** The last stretch that was started (in the sample worker); `whenReady` waits for it. */
    private renderJob: Promise<void> = Promise.resolve();
    /** This track's lane in the sample worker: a new render replaces the one still waiting. A symbol, so Vue never wraps it. */
    private readonly renderLane = Symbol('render');
    /**
     * Every voice still sounding, with the times (seconds) it starts and ends by itself. Raw, because the track itself is
     * reactive: through Vue's proxy the map hands out proxied voices, and a proxied Tone node reaches its
     * standardized-audio-context nodes through proxies too. Those look their context up in a WeakMap, miss it and
     * throw `InvalidStateError` on `dispose()`, which then broke removing the track (or loading a new sample) while a
     * voice still sounded.
     */
    private readonly voices = markRaw(new Map<ToneBufferSource, { start: number; end: number }>());

    /** Live notes (MIDI) in gate mode, by id: the voice a note-off stops. One-shot notes are not kept. Raw, as `voices`. */
    private readonly liveVoices = markRaw(new Map<string, ToneBufferSource>());

    /** The last sample load that was started; `whenReady` waits for it. */
    private loading: Promise<void> = Promise.resolve();

    constructor(id?: string) {
        super(id);
        this.connectSource(this.input);
    }

    /** Decodes `blob`, makes it the sample and resets the region to the whole sample. Slices are dropped, pitch and speed stay. */
    async loadSample(blob: Blob, name: string | null = this.sampleName): Promise<void> {
        const buffer = await decodeBlob(blob);

        this.stopVoices();
        this.buffer = markRaw(buffer);
        this.sampleBlob = blob;
        this.sampleName = name;
        this.cuts = [];
        this.setSampleTimes(0, buffer.duration);
        this.render();
        this.hasSample = true;
    }

    /**
     * Resolves once the sample the track was last given is decoded and its rendition (the stretched region) is
     * made; right away when there is no sample. An offline render depends on this: its transport starts as soon as
     * this resolves, and a step without a rendition stays silent. A render still waiting for the knobs to rest is
     * started right away.
     */
    override async whenReady(): Promise<void> {
        // Loading or rendering again while we wait means waiting for that too, until nothing new was started.
        for (;;) {
            const loading = this.loading;
            await loading;
            if (this.renderTimer !== null) {
                this.render();
            }
            const job = this.renderJob;
            await job;
            if (loading === this.loading && job === this.renderJob && this.renderTimer === null) {
                return;
            }
        }
    }

    /** Forgets the sample; the row shows its drop zone or record button again. */
    clearSample(): void {
        this.stopVoices();
        this.cancelRender();
        this.buffer = null;
        this.rendition = null;
        this.sampleBlob = null;
        this.sampleName = null;
        this.hasSample = false;
        this.cuts = [];
        this.setSampleTimes(0, 0);
    }

    /** Length of the decoded sample in seconds (0 without one). */
    get sampleLength(): number {
        return this.buffer?.duration ?? 0;
    }

    setSampleTimes(start: number, duration: number): void {
        this.sampleStartTime = start;
        this.sampleDuration = duration;
        // A stretched rendition only covers the region; an untouched one is the whole sample and still fits. One
        // that is still being made covers the old region, so a stretching track renders again either way.
        if ((this.rendition && this.rendition.stretch !== 1) || !this.isIdentity(this.stretchFactor)) {
            this.scheduleRender();
        }
    }

    setReversed(reversed: boolean): void {
        this.isReversed = reversed;
    }

    toggleReverse(): void {
        this.setReversed(!this.isReversed);
    }

    /* ---- pitch and speed ---- */

    setPitch(semitones: number): void {
        const pitch = clamp(Math.round(semitones), -SAMPLE_PITCH_RANGE, SAMPLE_PITCH_RANGE);
        if (pitch !== this.pitch) {
            this.pitch = pitch;
            this.scheduleRender();
        }
    }

    setSpeed(speed: number): void {
        const next = clamp(speed, MIN_SAMPLE_SPEED, MAX_SAMPLE_SPEED);
        if (next !== this.speed) {
            this.speed = next;
            this.scheduleRender();
        }
    }

    /**
     * How much longer (or shorter) the region has to be made for the current pitch and speed.
     *
     * The pitch is applied by playing the stretched region at the pitch ratio (`trigger`), not by Signalsmith's
     * own transposition: the rate change keeps the pitch exact, the transposition measured up to +22 cents off
     * at 110-220 Hz and +79 cents at 55 Hz. The numbers are in `dsp/sampleProtocol.ts`.
     */
    private get stretchFactor(): number {
        return semitoneRatio(this.pitch) / this.speed;
    }

    private isIdentity(stretch: number): boolean {
        return Math.abs(stretch - 1) < IDENTITY_EPSILON;
    }

    /** Works the stretched audio out again once the knobs have come to rest. */
    private scheduleRender(): void {
        if (!this.buffer) {
            return;
        }
        this.cancelRender();
        this.renderTimer = setTimeout(() => this.render(), RENDER_DELAY);
    }

    private cancelRender(): void {
        if (this.renderTimer !== null) {
            clearTimeout(this.renderTimer);
            this.renderTimer = null;
        }
    }

    /** What the rendition should be made from right now, or null without a sample. */
    private renditionPlan(): RenditionPlan | null {
        const buffer = this.buffer;
        if (!buffer) {
            return null;
        }
        const rate = buffer.sampleRate;
        const from = clamp(Math.floor(this.sampleStartTime * rate), 0, buffer.length - 1);
        const to = clamp(Math.ceil((this.sampleStartTime + this.sampleDuration) * rate), from + 1, buffer.length);
        return { buffer, from, to, stretch: this.stretchFactor, pitch: this.pitch };
    }

    /** Whether a job started for `plan` still gives what the track asks for. */
    private isCurrent(plan: RenditionPlan): boolean {
        const now = this.renditionPlan();
        return !!now && now.buffer === plan.buffer && now.from === plan.from && now.to === plan.to && now.stretch === plan.stretch && now.pitch === plan.pitch;
    }

    /**
     * Makes the audio the steps play from. Only the region is stretched: the rest of the sample never sounds.
     * Stretching runs in the sample worker; until it is done the steps keep playing the previous rendition, as they
     * do while the knobs move. The answer is only used if pitch, speed, region and sample are still what it was made for.
     */
    private render(): void {
        this.cancelRender();
        const plan = this.renditionPlan();
        if (!plan) {
            this.rendition = null;
            this.renderJob = Promise.resolve();
            return;
        }
        if (this.isIdentity(plan.stretch)) {
            this.rendition = markRaw({ buffer: plan.buffer, reversed: null, origin: 0, stretch: 1, pitch: plan.pitch });
            this.renderJob = Promise.resolve();
            return;
        }

        const { buffer, from, to, stretch } = plan;
        this.renderJob = sampleJobs()
            .stretch({ source: this.sampleBlob ?? buffer, buffer, from, to, factor: stretch, lane: this.renderLane })
            .then((stretched) => {
                if (!stretched || !this.isCurrent(plan)) {
                    return;
                }
                const rate = buffer.sampleRate;
                const result = this.input.context.createBuffer(stretched.length, stretched[0]!.length, rate);
                stretched.forEach((data, channel) => result.copyToChannel(data, channel));
                this.rendition = markRaw({ buffer: result, reversed: null, origin: from / rate, stretch: stretched[0]!.length / (to - from), pitch: plan.pitch });
            })
            .catch((error) => console.warn('Could not stretch the sample', this.sampleName, error));
    }

    /* ---- slices ---- */

    /** The parts of the region the steps can play: one (the region) until it is cut. */
    get slices(): SliceRange[] {
        return sliceRanges(this.sampleStartTime, this.sampleStartTime + this.sampleDuration, this.cuts);
    }

    get isSliced(): boolean {
        return this.slices.length > 1;
    }

    setCuts(cuts: readonly number[]): void {
        this.cuts = normalizeCuts(cuts);
    }

    addCut(time: number): void {
        this.setCuts([...this.cuts, time]);
    }

    removeCut(index: number): void {
        this.setCuts(this.cuts.filter((_, i) => i !== index));
    }

    moveCut(index: number, time: number): void {
        this.setCuts(this.cuts.map((cut, i) => (i === index ? time : cut)));
    }

    /** Cuts the region into `count` equal slices. */
    sliceEvenly(count: number): void {
        this.setCuts(evenCuts(this.sampleStartTime, this.sampleStartTime + this.sampleDuration, count));
    }

    /**
     * Cuts the region at every hit it finds. Resolves with how many slices that made. The search runs in the sample
     * worker; if the sample was replaced meanwhile the result is thrown away and the cuts stay as they are.
     */
    async sliceAtHits(options?: OnsetOptions): Promise<number> {
        const buffer = this.buffer;
        if (!buffer) {
            return 0;
        }
        const start = this.sampleStartTime;
        const onsets = await sampleJobs().onsets({ buffer, start, end: start + this.sampleDuration, options });
        if (onsets && buffer === this.buffer) {
            this.setCuts(onsets);
        }
        return this.slices.length;
    }

    clearCuts(): void {
        this.cuts = [];
    }

    /** The slice a note plays on a sliced sample: the root plays the first, every semitone up the next. Notes past either end play the nearest. */
    sliceIndexOf(note: string): number {
        return clamp(semitonesBetween(SAMPLE_ROOT_NOTE, note), 0, Math.max(0, this.slices.length - 1));
    }

    /** What a step with `note` plays: a slice when the sample is cut, otherwise the whole region shifted by the note. */
    private voiceOf(note: string): { range: SliceRange; semitones: number } | null {
        const slices = this.slices;
        if (slices.length > 1) {
            const slice = slices[this.sliceIndexOf(note)];
            return slice ? { range: slice, semitones: 0 } : null;
        }
        return slices[0] ? { range: slices[0], semitones: semitonesBetween(SAMPLE_ROOT_NOTE, note) } : null;
    }

    setGate(gate: boolean): void {
        this.gate = gate;
    }

    protected trigger(note: PatternNote, time: number, noteDuration: number): void {
        this.startVoice(note.note, note.velocity, time, noteDuration);
    }

    /**
     * A live note plays like a pattern note whose end is not known yet: in gate mode the voice plays until the
     * note-off stops it (or its slice ends), one-shot plays the slice out and ignores the note-off.
     */
    protected startLiveNote(id: string, note: string, velocity: number, time: number): void {
        const source = this.startVoice(note, velocity, time, Infinity);
        if (source && this.gate) {
            this.liveVoices.set(id, source);
        }
    }

    protected stopLiveNote(id: string, time: number): void {
        const source = this.liveVoices.get(id);
        if (!source) {
            return;
        }
        this.liveVoices.delete(id);
        const span = this.voices.get(source);
        if (span && span.end > time) {
            // The fade-out follows the stop, as when cutting notes.
            source.stop(Math.max(time, span.start));
            span.end = time;
        }
    }

    /** Starts the voice for a note (see the class comment); in gate mode it stops after `noteDuration` seconds. */
    private startVoice(noteName: string, velocity: number, time: number, noteDuration: number): ToneBufferSource | null {
        const rendition = this.rendition;
        if (!rendition) {
            return null;
        }
        const voice = this.voiceOf(noteName);
        if (!voice || voice.range.end <= voice.range.start) {
            return null;
        }

        let buffer = rendition.buffer;
        const length = (voice.range.end - voice.range.start) * rendition.stretch;
        let offset = clamp((voice.range.start - rendition.origin) * rendition.stretch, 0, buffer.duration);
        if (this.isReversed) {
            // Every slice plays backwards on its own: from its end to its start.
            rendition.reversed ??= this.reverse(buffer);
            buffer = rendition.reversed;
            offset = clamp(buffer.duration - offset - length, 0, buffer.duration);
        }

        if (this.cutsNotes) {
            this.cutVoices(time);
        }

        const rate = semitoneRatio(rendition.pitch + voice.semitones);
        const duration = Math.min(length, buffer.duration - offset) / rate;
        const source: ToneBufferSource = new ToneBufferSource({
            context: this.input.context,
            url: buffer,
            playbackRate: rate,
            fadeIn: VOICE_FADE,
            fadeOut: VOICE_FADE,
            curve: 'linear',
            // Tone disposes a finished source itself when online. Offline it must not: the clock runs ahead of the render there.
            // So offline the voice stays listed, and goes when the track is disposed after the render.
            onended: () => {
                if (!source.context.isOffline) {
                    this.voices.delete(source);
                }
            },
        }).connect(this.input);
        // The fade-out follows the stop, so it ends with the slice, or in gate mode with the note.
        const playFor = Math.max(0, (this.gate ? Math.min(duration, noteDuration) : duration) - VOICE_FADE);
        this.voices.set(source, { start: time, end: time + playFor });
        source.start(time, offset, playFor, velocity);
        return source;
    }

    /**
     * Fades out every voice that would still sound at `time`. Voices that end before it are left alone, and so are
     * voices starting at `time` itself: those are notes of the same chord.
     */
    private cutVoices(time: number): void {
        for (const [voice, span] of this.voices) {
            if (span.end > time && span.start < time) {
                voice.stop(time);
                span.end = time;
            }
        }
    }

    private reverse(buffer: AudioBuffer): AudioBuffer {
        const reversed = this.input.context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            reversed.copyToChannel(buffer.getChannelData(channel).slice().reverse(), channel);
        }
        return markRaw(reversed);
    }

    /**
     * Silences every voice right away without a click, so a new or cleared sample starts clean. A sounding voice
     * fades out as cutting notes does, and Tone disposes it once it has ended. A voice that is only scheduled (the
     * clock runs ahead of the audio) has made no sound yet and goes at once: stopping it before its start would leave
     * its fade-in ramp after the fade-out, so it would still sound until the stop comes round. Offline Tone never
     * disposes a finished source (see `trigger`), so there every voice goes at once.
     */
    private stopVoices(): void {
        this.liveVoices.clear();
        const context = this.input.context;
        const now = context.currentTime;
        for (const [voice, span] of this.voices) {
            if (context.isOffline || span.start > now) {
                voice.dispose();
            } else {
                voice.stop(now);
            }
        }
        this.voices.clear();
    }

    /** Drops every voice at once; the track's own output goes with it, so there is nothing left to fade. */
    private disposeVoices(): void {
        this.liveVoices.clear();
        for (const voice of this.voices.keys()) {
            voice.dispose();
        }
        this.voices.clear();
    }

    async copyFrom(source: this): Promise<void> {
        await super.copyFrom(source);

        if (source.sampleBlob) {
            await this.loadSample(source.sampleBlob, source.sampleName);
        }

        this.setSampleTimes(source.sampleStartTime, source.sampleDuration);
        this.setReversed(source.isReversed);
        this.setPitch(source.pitch);
        this.setSpeed(source.speed);
        this.setCuts(source.cuts);
        this.setGate(source.gate);
    }

    dispose(): void {
        this.cancelRender();
        // A stretch still running for this track finds no sample to match any more and is thrown away.
        this.buffer = null;
        this.disposeVoices();
        this.input.dispose();
        super.dispose();
    }

    capture(): SampleTrackState {
        return {
            ...super.capture(),
            sampleBlob: this.sampleBlob,
            sampleName: this.sampleName,
            sampleStartTime: this.sampleStartTime,
            sampleDuration: this.sampleDuration,
            isReversed: this.isReversed,
            pitch: this.pitch,
            speed: this.speed,
            cuts: [...this.cuts],
            gate: this.gate,
        };
    }

    restore(state: TrackState | LegacyTrackState): void {
        super.restore(state);
        const sample = state as SampleTrackState;
        const settle = () => {
            this.setSampleTimes(sample.sampleStartTime, sample.sampleDuration);
            this.setPitch(sample.pitch ?? 0);
            this.setSpeed(sample.speed ?? 1);
            this.setCuts(sample.cuts ?? []);
        };
        if (sample.sampleBlob !== this.sampleBlob) {
            if (sample.sampleBlob) {
                // Decoding is asynchronous; the region and the rest are set once the audio is back.
                this.loading = this.loadSample(sample.sampleBlob, sample.sampleName)
                    .then(settle)
                    .catch((error) => console.warn('Could not decode the sample', sample.sampleName, error));
            } else {
                this.clearSample();
                settle();
            }
        } else {
            this.sampleName = sample.sampleName;
            settle();
        }
        this.setReversed(sample.isReversed);
        this.setGate(sample.gate ?? false);
    }

    async serialize(): Promise<SampleTrackSnapshot> {
        return {
            ...(await super.serialize()),
            sampleName: this.sampleName,
            sampleStartTime: this.sampleStartTime,
            sampleDuration: this.sampleDuration,
            pitch: this.pitch,
            speed: this.speed,
            cuts: [...this.cuts],
            gate: this.gate,
            buffer: (await this.sampleBlob?.arrayBuffer()) ?? null,
        };
    }
}
