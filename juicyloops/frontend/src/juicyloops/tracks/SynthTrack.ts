import { Gain } from 'tone';
import { markRaw } from 'vue';
import type { AutomationParam } from '../automation';
import { NoteStack } from '../midi/liveNotes';
import type { OscillatorType } from '../notes';
import type { PatternNote } from '../notes/Note';
import type { LegacyTrackState } from '../notes/migrate';
import { AUTOMATABLE_PATCH_PARAMS, clampPatchValue, isPatchModel, normalizePatch, patchParam, SYNTH_MODELS, type PatchModel, type PatchValues, type SynthModel } from '../synths/params';
import { BaseTrack, type TrackSnapshot, type TrackState } from './BaseTrack';
import { copyPluginRef, isPluginRef, type PluginRef } from '../plugins/pluginRef';
import { setPluginStatus } from '../plugins/pluginStatus';
import { WamInstrument } from '../plugins/WamInstrument';
import { createSynthEngine, type SynthEngine, type SynthEnvelope, type SynthEnvelopeParam } from './synthEngine';

export type { SynthEnvelope, SynthEnvelopeParam } from './synthEngine';

export const DEFAULT_ENVELOPE: SynthEnvelope = { attack: 0.005, decay: 0.1, sustain: 0.3, release: 1 };

const seconds = (value: number) => (value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`);
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The envelope stages as knobs and automation see them. */
export const ENVELOPE_PARAMS: readonly (AutomationParam & { stage: SynthEnvelopeParam; hint: string })[] = [
    { key: 'envelope.attack', stage: 'attack', label: 'Attack', group: 'Synth', min: 0.001, max: 2, step: 0.001, curve: 'log', format: seconds, hint: 'How long the note takes to reach full volume' },
    { key: 'envelope.decay', stage: 'decay', label: 'Decay', group: 'Synth', min: 0.01, max: 2, step: 0.001, curve: 'log', format: seconds, hint: 'How long it takes to fall to the sustain level' },
    { key: 'envelope.sustain', stage: 'sustain', label: 'Sustain', group: 'Synth', min: 0, max: 1, step: 0.01, curve: 'linear', format: percent, hint: 'The level held while the note plays' },
    { key: 'envelope.release', stage: 'release', label: 'Release', group: 'Synth', min: 0.01, max: 4, step: 0.001, curve: 'log', format: seconds, hint: 'How long the tail rings out after the note ends' },
];

/** Semitones a full pitch bend reaches either way, unless the track says otherwise. */
export const DEFAULT_BEND_RANGE = 2;
/** The bend ranges the track settings offer. */
export const BEND_RANGES: readonly number[] = [1, 2, 3, 5, 7, 12, 24];
export const MAX_BEND_RANGE = 24;

const formatBend = (value: number) => (Math.abs(value) < 0.0005 ? '0' : `${value > 0 ? '+' : '−'}${Math.round(Math.abs(value) * 100)}%`);

/**
 * Pitch bend as knobs, automation and a MIDI wheel see it: -1..1 of the track's bend range (`bendRange`, semitones).
 * Stored as a fraction so one parameter table serves every track whatever its range.
 */
export const BEND_PARAM: AutomationParam & { hint: string } = {
    key: 'bend',
    label: 'Bend',
    group: 'Synth',
    min: -1,
    max: 1,
    step: 0.001,
    curve: 'linear',
    format: formatBend,
    hint: 'Pitch bend, as far as the bend range reaches either way',
};

const SYNTH_PARAMS: readonly AutomationParam[] = [...ENVELOPE_PARAMS, BEND_PARAM];

const PATCH_PREFIX = 'patch.';

/** A stored model name, or classic for anything else (sessions from before models). */
const readModel = (value: unknown): SynthModel => (SYNTH_MODELS.includes(value as SynthModel) ? (value as SynthModel) : 'classic');

const ENVELOPE_PREFIX = 'envelope.';
const envelopeStage = (key: string): SynthEnvelopeParam | null => (key.startsWith(ENVELOPE_PREFIX) ? (key.slice(ENVELOPE_PREFIX.length) as SynthEnvelopeParam) : null);

export interface SynthTrackSnapshot extends TrackSnapshot {
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
    /** Missing in snapshots from before pitch bend: 0 and `DEFAULT_BEND_RANGE` then. */
    bend?: number;
    bendRange?: number;
    /** Missing in snapshots from before synth models: classic then. */
    model?: SynthModel;
    /** The patch of an analog, wavetable or FM synth, by parameter key. */
    patch?: PatchValues;
    /** The plugin of a plugin synth, with its state. */
    plugin?: PluginRef | null;
}

export interface SynthTrackState extends TrackState {
    oscillatorType: OscillatorType;
    envelope: SynthEnvelope;
    bend?: number;
    bendRange?: number;
    model?: SynthModel;
    patch?: PatchValues;
    plugin?: PluginRef | null;
}

/** A live note on the synth: its engine id (a number, the engines' `noteOn` id), note and velocity. */
interface LiveSynthNote {
    engineId: number;
    note: string;
    velocity: number;
}

/**
 * Plays the notes of its pattern, each for its length. Cutting notes (the default) plays them on one voice, so a new note takes over
 * from the one before; overlapping plays every note on a voice of its own, so long notes and release tails ring on.
 */
export class SynthTrack extends BaseTrack {
    readonly type = 'synth';

    override cutsNotes = true;

    /** Where the synth goes; the effect chain starts here. */
    private readonly input = markRaw(new Gain());
    /** Every voice of the track (see `synthEngine.ts`). Null while the track sleeps. */
    private engine: SynthEngine | null = null;

    oscillatorType: OscillatorType = 'sine';

    envelope: SynthEnvelope = { ...DEFAULT_ENVELOPE };

    /** The stored pitch bend (the knob), -1..1 of `bendRange`. Automation and the MIDI wheel play over it. */
    bend = 0;

    /** Semitones a full bend reaches either way. */
    bendRange = DEFAULT_BEND_RANGE;

    /**
     * What makes the sound: the classic one-oscillator synth (`oscillatorType` and `envelope`), one of the patch
     * synths (analog, wavetable, FM: `patch`), or a plugin.
     */
    model: SynthModel = 'classic';

    /** The patch of a patch model, every parameter by key (`patch.filter.cutoff`); empty for the others. */
    patch: PatchValues = {};

    /**
     * The plugin of the `plugin` model (null until one is picked). Its `state` is what the plugin last reported
     * (`refreshPluginState`): history, saves and renders use it.
     */
    plugin: PluginRef | null = null;

    /** Live notes by their MIDI id. Raw: the track itself is reactive. */
    private readonly liveNotes = markRaw(new Map<string, LiveSynthNote>());
    /** Last-note priority in cut mode (see `NoteStack`). */
    private readonly liveStack = markRaw(new NoteStack<LiveSynthNote>());
    private nextEngineId = 1;

    constructor(id?: string) {
        super(id);
        this.buildEngine();
        this.connectSource(this.input);
    }

    protected trigger(note: PatternNote, time: number, duration: number): void {
        this.engine?.triggerAttackRelease(note.note, duration, time, note.velocity);
    }

    protected startLiveNote(id: string, note: string, velocity: number, time: number): void {
        const live: LiveSynthNote = { engineId: this.nextEngineId, note, velocity };
        // Whole numbers above 0 (0 is a scheduled note in the Rust engine), and within its u32.
        this.nextEngineId = this.nextEngineId >= 0x7fffffff ? 1 : this.nextEngineId + 1;
        this.liveNotes.set(id, live);
        if (this.cutsNotes) {
            this.liveStack.press(id, live);
        }
        this.engine?.noteOn(live.engineId, note, time, velocity);
    }

    protected stopLiveNote(id: string, time: number): void {
        const live = this.liveNotes.get(id);
        if (!live) {
            return;
        }
        this.liveNotes.delete(id);
        if (this.cutsNotes) {
            // Last-note priority: when the note that sounds comes up, the newest key still held takes over (legato).
            const next = this.liveStack.release(id);
            if (next) {
                this.engine?.noteOn(next.value.engineId, next.value.note, time, next.value.velocity);
            }
        }
        this.engine?.noteOff(live.engineId, time);
    }

    /** Every held note stops; none of them takes over from another on the way (cut mode). */
    override allNotesOff(time: number): void {
        this.liveStack.clear();
        super.allNotesOff(time);
    }

    /** The wheel plays on top of the stored bend (the knob), so the centre position gives the knob's bend back. */
    override setLiveBend(value: number, time: number): void {
        this.engine?.setBend(Math.min(1, Math.max(-1, this.bend + value)) * this.bendRange, time);
    }

    override setLiveModWheel(value: number, time: number): void {
        this.setPatch('patch.modWheel', value, time);
    }

    override setCutsNotes(cuts: boolean): void {
        // Held notes belong to the mode they started in.
        if (cuts !== this.cutsNotes) {
            this.allNotesOff(this.now);
        }
        super.setCutsNotes(cuts);
        this.engine?.setCutsNotes(cuts);
    }

    /** A sleeping track has no engine at all (except a plugin): its nodes would be processed even while silent. */
    override sleep(): void {
        this.allNotesOff(this.now);
        super.sleep();
        // A plugin stays: reloading it would lose whatever was changed in its window since its state was last read.
        if (this.model !== 'plugin') {
            this.disposeEngine();
        }
    }

    override wake(): void {
        super.wake();
        this.buildEngine();
    }

    override whenReady(): Promise<void> {
        return this.engine?.whenReady() ?? Promise.resolve();
    }

    /** Builds the engine with the stored mode, oscillator and envelope. */
    private buildEngine(): void {
        if (this.engine) {
            return;
        }
        if (this.model === 'plugin') {
            if (!this.plugin) {
                // No plugin picked yet: no engine, no sound.
                return;
            }
            const plugin = markRaw(new WamInstrument({ context: this.input.context, owner: this.id, plugin: copyPluginRef(this.plugin), bendRange: this.bendRange }));
            plugin.connect(this.input);
            this.engine = plugin;
            return;
        }
        const model = this.model;
        const settings = {
            context: this.input.context,
            cutsNotes: this.cutsNotes,
            oscillatorType: this.oscillatorType,
            envelope: { ...this.envelope },
            bend: this.bend * this.bendRange,
            model,
            patch: { ...this.patch },
        };
        const engine = createSynthEngine(settings, () => {
            // The worklet engine could not start: rebuild, which gives the Tone engine from now on.
            if (this.engine === engine) {
                this.disposeEngine();
                if (!this.isAsleep) {
                    this.buildEngine();
                }
            }
        });
        engine.connect(this.input);
        this.engine = engine;
    }

    private disposeEngine(): void {
        this.engine?.dispose();
        this.engine = null;
    }

    /**
     * Switches the model. A patch model starts from `patch` (a preset) or its defaults; the engine is rebuilt, so
     * notes that sound stop. For the model the track already plays, `patch` is applied like a preset. Automation lanes of parameters the new model has not got are dropped.
     */
    setModel(model: SynthModel, patch?: Readonly<Record<string, unknown>>): void {
        if (model === this.model) {
            // Same model: only the values change, and the engine keeps playing.
            if (patch) {
                this.applyPatch(patch);
            }
            return;
        }
        this.allNotesOff(this.now);
        this.disposeEngine();
        this.model = model;
        this.patch = isPatchModel(model) ? normalizePatch(model, patch) : {};
        for (const lane of [...this.automation.lanes]) {
            if (!this.parameter(lane.param)) {
                this.automation.remove(lane.id);
            }
        }
        if (model !== 'plugin') {
            setPluginStatus(this.id, null);
        }
        if (!this.isAsleep) {
            this.buildEngine();
        }
    }

    /** Plays a plugin (from the browser, or a stored one): the model becomes `plugin` and the engine is rebuilt. */
    setPlugin(plugin: PluginRef): void {
        this.allNotesOff(this.now);
        this.disposeEngine();
        this.plugin = copyPluginRef(plugin);
        if (this.model !== 'plugin') {
            this.setModel('plugin');
        } else if (!this.isAsleep) {
            this.buildEngine();
        }
    }

    /** Asks the plugin for its state and keeps it, so history, saves and renders have the plugin as it sounds now. */
    async refreshPluginState(): Promise<void> {
        const engine = this.engine;
        if (this.model !== 'plugin' || !this.plugin || !engine?.getState) {
            return;
        }
        const state = await engine.getState();
        if (state !== null && this.plugin) {
            this.plugin = { ...this.plugin, state };
        }
    }

    /** The loaded plugin engine (its GUI), or null. */
    get pluginEngine(): WamInstrument | null {
        return this.engine instanceof WamInstrument ? this.engine : null;
    }

    /** The patch model the track plays, or null for classic and plugin. */
    get patchModel(): PatchModel | null {
        return isPatchModel(this.model) ? this.model : null;
    }

    /** Sets one patch parameter by key (`patch.filter.cutoff`). With a `time` it is only played (automation), not stored. */
    setPatch(key: string, value: number, time?: number): void {
        const model = this.patchModel;
        const param = model ? patchParam(model, key) : undefined;
        if (!param) {
            return;
        }
        const clamped = clampPatchValue(param, value);
        this.engine?.setPatchParam(param.id, clamped, time);
        if (time === undefined) {
            this.patch = { ...this.patch, [key]: clamped };
        }
    }

    /** Sets many patch parameters at once (a preset), keeping the model. */
    applyPatch(values: Readonly<Record<string, unknown>>): void {
        const model = this.patchModel;
        if (!model) {
            return;
        }
        const patch = normalizePatch(model, values);
        for (const [key, value] of Object.entries(patch)) {
            if (this.patch[key] !== value) {
                this.setPatch(key, value);
            }
        }
    }

    /** The classic synth's oscillator. Stored whatever the model; only a classic engine hears it. */
    setOscillatorType(type: OscillatorType): void {
        if (this.model === 'classic') {
            this.engine?.setOscillatorType(type);
        }
        this.oscillatorType = type;
    }

    /** Sets one stage of the amplitude envelope, e.g. `setEnvelope('attack', 0.2)`. */
    setEnvelope(param: SynthEnvelopeParam, value: number, time?: number): void {
        if (this.model === 'classic') {
            this.engine?.setEnvelope(param, value, time);
        }
        if (time === undefined) {
            this.envelope = { ...this.envelope, [param]: value };
        }
    }

    /** Sets the pitch bend, -1..1 of the bend range. With a `time` it is only played (automation), not stored. */
    setBend(value: number, time?: number): void {
        const bend = Math.min(1, Math.max(-1, value));
        this.engine?.setBend(bend * this.bendRange, time);
        if (time === undefined) {
            this.bend = bend;
        }
    }

    /** How many semitones a full bend reaches either way (1..24). */
    setBendRange(semitones: number): void {
        this.bendRange = Math.min(MAX_BEND_RANGE, Math.max(1, Math.round(semitones)));
        this.engine?.setBendRange?.(this.bendRange);
        this.engine?.setBend(this.bend * this.bendRange);
    }

    protected ownParameters(): readonly AutomationParam[] {
        const model = this.patchModel;
        if (model) {
            return [...AUTOMATABLE_PATCH_PARAMS[model], BEND_PARAM];
        }
        return this.model === 'plugin' ? [BEND_PARAM] : SYNTH_PARAMS;
    }

    protected override parameterVariant(): unknown {
        return `synth:${this.model}`;
    }

    getParameter(key: string): number {
        if (key === BEND_PARAM.key) {
            return this.bend;
        }
        if (key.startsWith(PATCH_PREFIX)) {
            return this.patch[key] ?? 0;
        }
        const stage = envelopeStage(key);
        return stage && stage in this.envelope ? this.envelope[stage] : super.getParameter(key);
    }

    setParameter(key: string, value: number, time?: number): void {
        const stage = envelopeStage(key);
        if (key === BEND_PARAM.key) {
            this.setBend(value, time);
        } else if (key.startsWith(PATCH_PREFIX)) {
            this.setPatch(key, value, time);
        } else if (stage && stage in this.envelope && this.model === 'classic') {
            this.setEnvelope(stage, value, time);
        } else {
            super.setParameter(key, value, time);
        }
    }

    async copyFrom(source: this): Promise<void> {
        if (source.model === 'plugin' && source.plugin) {
            await source.refreshPluginState();
            this.setPlugin(source.plugin);
        } else {
            this.setModel(source.model, source.patch);
        }
        await super.copyFrom(source);
        this.setOscillatorType(source.oscillatorType);
        for (const param of Object.keys(source.envelope) as SynthEnvelopeParam[]) {
            this.setEnvelope(param, source.envelope[param]);
        }
        this.setBendRange(source.bendRange);
        this.setBend(source.bend);
    }

    dispose(): void {
        this.disposeEngine();
        setPluginStatus(this.id, null);
        this.input.dispose();
        super.dispose();
    }

    capture(): SynthTrackState {
        return {
            ...super.capture(),
            oscillatorType: this.oscillatorType,
            envelope: { ...this.envelope },
            bend: this.bend,
            bendRange: this.bendRange,
            model: this.model,
            patch: { ...this.patch },
            plugin: this.plugin ? copyPluginRef(this.plugin) : null,
        };
    }

    restore(state: TrackState | LegacyTrackState): void {
        const synth = state as SynthTrackState;
        // The model first: it decides which parameters (and so which automation lanes) the track has.
        const model = readModel(synth.model);
        if (model === 'plugin' && isPluginRef(synth.plugin)) {
            if (!this.plugin || this.plugin.url !== synth.plugin.url || JSON.stringify(this.plugin.state) !== JSON.stringify(synth.plugin.state)) {
                this.setPlugin(synth.plugin);
            }
        } else {
            this.setModel(model, synth.patch);
        }
        super.restore(state);
        this.setOscillatorType(synth.oscillatorType);
        for (const param of Object.keys(synth.envelope) as SynthEnvelopeParam[]) {
            this.setEnvelope(param, synth.envelope[param]);
        }
        this.setBendRange(synth.bendRange ?? DEFAULT_BEND_RANGE);
        this.setBend(synth.bend ?? 0);
    }

    async serialize(): Promise<SynthTrackSnapshot> {
        await this.refreshPluginState();
        return {
            ...(await super.serialize()),
            oscillatorType: this.oscillatorType,
            envelope: { ...this.envelope },
            bend: this.bend,
            bendRange: this.bendRange,
            model: this.model,
            patch: { ...this.patch },
            plugin: this.plugin ? copyPluginRef(this.plugin) : null,
        };
    }
}
