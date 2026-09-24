import { Gain, ToneBufferSource } from 'tone';
import { markRaw } from 'vue';
import { decodeBlob } from '../audio';
import { semitonesBetween } from '../notes';
import { detectOnsets, evenCuts, normalizeCuts, sliceRanges, type OnsetOptions, type SliceRange } from '../slices';
import { semitoneRatio, timeStretch } from '../stretch';
import { SAMPLE_ROOT_NOTE, SampleTick } from '../ticks/SampleTick';
import { BaseTrack, type TrackSnapshot, type TrackState } from './BaseTrack';

export interface SampleTrackSnapshot extends TrackSnapshot {
    sampleName: string | null;
    sampleStartTime: number;
    sampleDuration: number;
    pitch: number;
    speed: number;
    cuts: number[];
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A track that plays a slice of an audio buffer on every active tick.
 * Where the buffer comes from (a file, the microphone, ...) is up to the subclass.
 *
 * Pitch and speed are independent: the played region is time-stretched so that, played back at the pitch
 * ratio, it lasts exactly as long as the speed says. With neither turned, the sample plays untouched.
 *
 * Every step starts a voice of its own, so a long slice rings on under the next one, the step's velocity sets
 * its level and its note decides what it plays (see `SampleTick`).
 */
export abstract class SampleTrack extends BaseTrack<SampleTick> {
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

    /** The decoded sample. */
    private buffer: AudioBuffer | null = null;
    private rendition: Rendition | null = null;
    private renderTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly voices = new Set<ToneBufferSource>();

    /** The last sample load that was started; `whenReady` waits for it. */
    private loading: Promise<void> = Promise.resolve();

    constructor(id?: string) {
        super(id);
        this.connectSource(this.input);
    }

    protected createTick(): SampleTick {
        return new SampleTick();
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

    /** Resolves once the sample the track was last given is decoded and playable (right away when there is none). */
    override whenReady(): Promise<void> {
        return this.loading.then(() => {
            if (this.renderTimer !== null) {
                this.render();
            }
        });
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
        // A stretched rendition only covers the region; an untouched one is the whole sample and still fits.
        if (this.rendition && this.rendition.stretch !== 1) {
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

    /** How much longer (or shorter) the region has to be made for the current pitch and speed. */
    private get stretchFactor(): number {
        return semitoneRatio(this.pitch) / this.speed;
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

    /** Makes the audio the steps play from. Only the region is stretched: the rest of the sample never sounds. */
    private render(): void {
        this.cancelRender();
        const buffer = this.buffer;
        if (!buffer) {
            this.rendition = null;
            return;
        }

        const stretch = this.stretchFactor;
        if (Math.abs(stretch - 1) < 1e-4) {
            this.rendition = markRaw({ buffer, reversed: null, origin: 0, stretch: 1, pitch: this.pitch });
            return;
        }

        const rate = buffer.sampleRate;
        const from = clamp(Math.floor(this.sampleStartTime * rate), 0, buffer.length - 1);
        const to = clamp(Math.ceil((this.sampleStartTime + this.sampleDuration) * rate), from + 1, buffer.length);
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).subarray(from, to));
        const stretched = timeStretch(channels, rate, stretch);
        const result = this.input.context.createBuffer(stretched.length, stretched[0]!.length, rate);
        stretched.forEach((data, channel) => result.copyToChannel(data, channel));
        this.rendition = markRaw({ buffer: result, reversed: null, origin: from / rate, stretch: (to - from) > 0 ? stretched[0]!.length / (to - from) : stretch, pitch: this.pitch });
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

    /** Cuts the region at every hit it finds. Returns how many slices that made. */
    sliceAtHits(options?: OnsetOptions): number {
        if (!this.buffer) {
            return 0;
        }
        const buffer = this.buffer;
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
        this.setCuts(detectOnsets(channels, buffer.sampleRate, this.sampleStartTime, this.sampleStartTime + this.sampleDuration, options));
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

    protected trigger(step: number, time: number): void {
        const tick = this.activeTick(step);
        const rendition = this.rendition;
        if (!tick || !rendition) {
            return;
        }
        const voice = this.voiceOf(tick.note);
        if (!voice || voice.range.end <= voice.range.start) {
            return;
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
            onended: () => this.voices.delete(source),
        }).connect(this.input);
        this.voices.add(source);
        source.start(time, offset, Math.max(0, duration - VOICE_FADE), tick.volume);
    }

    private reverse(buffer: AudioBuffer): AudioBuffer {
        const reversed = this.input.context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            reversed.copyToChannel(buffer.getChannelData(channel).slice().reverse(), channel);
        }
        return markRaw(reversed);
    }

    private stopVoices(): void {
        for (const voice of this.voices) {
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
    }

    dispose(): void {
        this.cancelRender();
        this.stopVoices();
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
        };
    }

    restore(state: TrackState): void {
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
            buffer: (await this.sampleBlob?.arrayBuffer()) ?? null,
        };
    }
}
