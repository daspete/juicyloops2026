import { PolySynth, Synth, type BaseContext, type InputNode } from 'tone';
import { PARAM_RAMP_TIME } from '../constants';
import { markRaw } from 'vue';
import { atTime } from '../automation';
import { isSynthWorkletUsable, SynthVoices } from '../dsp/SynthVoices';
import type { OscillatorType } from '../notes';

/** Amplitude envelope of the synth voice. Times are seconds, sustain is a level between 0 and 1. */
export interface SynthEnvelope {
    attack: number;
    decay: number;
    sustain: number;
    release: number;
}

export type SynthEnvelopeParam = keyof SynthEnvelope;

/** What a synth engine starts with. */
export interface SynthEngineSettings {
    context: BaseContext;
    cutsNotes: boolean;
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
    /** Pitch bend of every voice, in semitones. */
    bend: number;
}

/** The sound source of a `SynthTrack`: every voice of the track, behind one output. */
export interface SynthEngine {
    /** Plays a note (name or Hz) at `time` for `duration` (a note length or seconds); returns the length in seconds. */
    triggerAttackRelease(note: string | number, duration: string | number, time: number, velocity?: number): number;
    /**
     * Starts a live note (MIDI) that sounds until `noteOff` with the same `id` (a whole number above 0). In cut mode
     * a new note takes over the one that sounds, and a `noteOff` for a note that was taken over does nothing.
     */
    noteOn(id: number, note: string | number, time: number, velocity: number): void;
    noteOff(id: number, time: number): void;
    /** Pitch bend of every voice in semitones: at `time` (automation) or right away, with a short glide either way. */
    setBend(semitones: number, time?: number): void;
    setCutsNotes(cuts: boolean): void;
    setOscillatorType(type: OscillatorType): void;
    /** With a `time`, the change is scheduled for then. */
    setEnvelope(param: SynthEnvelopeParam, value: number, time?: number): void;
    /** Resolves once notes can sound (the worklet engine loads its module first). */
    whenReady(): Promise<void>;
    connect(destination: InputNode): unknown;
    dispose(): unknown;
}

/**
 * The Rust engine (`SynthVoices`, one AudioWorklet per track) is the default. `PUBLIC_RUST_SYNTH=false` selects the
 * Tone.js engine below for one more release; it is also the fallback where AudioWorklet is missing (an insecure
 * origin such as the plain-http dev host) or the worklet failed to load.
 */
export const RUST_SYNTH = import.meta.env.PUBLIC_RUST_SYNTH !== 'false';

/**
 * Builds the engine for a track. `onFailure` is called when the worklet engine cannot load after all; the track then
 * builds a new engine, which is the Tone one from then on.
 */
export const createSynthEngine = (settings: SynthEngineSettings, onFailure: () => void): SynthEngine =>
    RUST_SYNTH && isSynthWorkletUsable(settings.context)
        ? markRaw(new SynthVoices({ ...settings, onFailure }))
        : markRaw(new ToneSynthEngine(settings));

/** Extra time an engine switched away from keeps ringing after its last note's release, in seconds. */
const RELEASE_MARGIN = 0.1;

/**
 * The Tone.js synth (the engine before 2.2, kept behind `PUBLIC_RUST_SYNTH=false` for one release). Cutting notes
 * play on one `Synth`, overlapping ones on a `PolySynth`. Only the engine for the current mode is built; the one
 * switched away from is disposed once a note it may still be playing has rung out.
 */
export class ToneSynthEngine implements SynthEngine {
    private readonly context: BaseContext;
    /** Where the engines play into; one built later connects there too. */
    private destination: InputNode | null = null;
    private cutsNotes: boolean;
    private oscillatorType: OscillatorType;
    private envelope: SynthEnvelope;
    /** In cents, Tone's `detune`. */
    private detune: number;
    private synth: Synth | null = null;
    private polySynth: PolySynth | null = null;
    /** The pending disposal of the engine that was switched away from, keyed by which one it is. */
    private readonly retiring = new Map<'synth' | 'polySynth', number>();
    /** Context time the last scheduled note is released at, so a retired engine can ring out its tail. */
    private lastNoteOff = -Infinity;
    /** Live notes: in cut mode the id that sounds; with overlapping notes the note each id plays. */
    private liveCurrent: number | null = null;
    private readonly liveNotes = new Map<number, string | number>();

    constructor({ context, cutsNotes, oscillatorType, envelope, bend }: SynthEngineSettings) {
        this.context = context;
        this.cutsNotes = cutsNotes;
        this.oscillatorType = oscillatorType;
        this.envelope = { ...envelope };
        this.detune = bend * 100;
        this.engine();
    }

    noteOn(id: number, note: string | number, time: number, velocity: number): void {
        const engine = this.engine();
        engine.triggerAttack(note, time, velocity);
        if (this.cutsNotes) {
            this.liveCurrent = id;
        } else {
            this.liveNotes.set(id, note);
        }
    }

    noteOff(id: number, time: number): void {
        this.lastNoteOff = Math.max(this.lastNoteOff, time);
        if (this.cutsNotes) {
            if (this.liveCurrent === id) {
                this.liveCurrent = null;
                this.synth?.triggerRelease(time);
            }
            return;
        }
        const note = this.liveNotes.get(id);
        if (note !== undefined) {
            this.liveNotes.delete(id);
            this.polySynth?.triggerRelease(note, time);
        }
    }

    setBend(semitones: number, time?: number): void {
        const cents = semitones * 100;
        if (time === undefined) {
            this.detune = cents;
        }
        const at = time ?? this.context.currentTime;
        this.synth?.detune.rampTo(cents, PARAM_RAMP_TIME, at);
        if (this.polySynth) {
            // The PolySynth has no detune of its own: every voice it made glides, and new voices start from `options`.
            const poly = this.polySynth as unknown as { _voices: Synth[]; options: { detune: number } };
            for (const voice of poly._voices) {
                voice.detune.rampTo(cents, PARAM_RAMP_TIME, at);
            }
            poly.options.detune = cents;
        }
    }

    triggerAttackRelease(note: string | number, duration: string | number, time: number, velocity?: number): number {
        const engine = this.engine();
        engine.triggerAttackRelease(note, duration, time, velocity);
        const seconds = engine.toSeconds(duration);
        this.lastNoteOff = Math.max(this.lastNoteOff, time + seconds);
        return seconds;
    }

    setCutsNotes(cuts: boolean): void {
        this.cutsNotes = cuts;
        this.engine();
        this.retire(cuts ? 'polySynth' : 'synth');
    }

    setOscillatorType(type: OscillatorType): void {
        this.oscillatorType = type;
        this.synth?.set({ oscillator: { type } });
        this.polySynth?.set({ oscillator: { type } });
    }

    setEnvelope(param: SynthEnvelopeParam, value: number, time?: number): void {
        if (time === undefined) {
            this.envelope = { ...this.envelope, [param]: value };
        }
        atTime(this.context, time, () => {
            this.synth?.set({ envelope: { [param]: value } });
            this.polySynth?.set({ envelope: { [param]: value } });
        });
    }

    whenReady(): Promise<void> {
        return Promise.resolve();
    }

    connect(destination: InputNode): void {
        this.destination = destination;
        this.synth?.connect(destination);
        this.polySynth?.connect(destination);
    }

    dispose(): void {
        this.disposeEngine('synth');
        this.disposeEngine('polySynth');
        this.destination = null;
    }

    /** The engine for the current mode, built (with the stored oscillator and envelope) on first use. */
    private engine(): Synth | PolySynth {
        const key = this.cutsNotes ? 'synth' : 'polySynth';
        this.cancelRetire(key);
        const existing = this[key];
        if (existing) {
            return existing;
        }

        const options = { context: this.context, oscillator: { type: this.oscillatorType }, envelope: { ...this.envelope }, detune: this.detune };
        const engine = this.cutsNotes ? markRaw(new Synth(options)) : markRaw(new PolySynth(Synth, options));
        if (this.destination) {
            engine.connect(this.destination);
        }
        if (this.cutsNotes) {
            this.synth = engine as Synth;
        } else {
            this.polySynth = engine as PolySynth;
        }
        return engine;
    }

    /**
     * Disposes an engine that is no longer played: right away when nothing it played can still sound, otherwise
     * after the last note's release tail. An offline render runs its whole clock before it renders any audio, so a
     * timer there would fire before the tail is heard; the engine then simply lives until the track is disposed.
     */
    private retire(key: 'synth' | 'polySynth'): void {
        const engine = this[key];
        if (!engine || this.retiring.has(key)) {
            return;
        }

        const context = this.context;
        const tail = this.lastNoteOff + this.envelope.release + RELEASE_MARGIN - context.currentTime;
        if (tail <= 0) {
            this.disposeEngine(key);
        } else if (!context.isOffline) {
            this.retiring.set(key, context.setTimeout(() => this.disposeEngine(key), tail));
        }
    }

    private cancelRetire(key: 'synth' | 'polySynth'): void {
        const timer = this.retiring.get(key);
        if (timer !== undefined) {
            this.context.clearTimeout(timer);
            this.retiring.delete(key);
        }
    }

    private disposeEngine(key: 'synth' | 'polySynth'): void {
        this.cancelRetire(key);
        this[key]?.dispose();
        this[key] = null;
    }
}
