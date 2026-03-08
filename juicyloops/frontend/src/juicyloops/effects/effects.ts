import {
    AutoFilter,
    BitCrusher,
    Chorus,
    Compressor,
    connectSeries,
    Distortion,
    EQ3,
    FeedbackDelay,
    Limiter,
    Phaser,
    Reverb,
    Tremolo,
    Unit,
    Vibrato,
    type ToneAudioNode,
} from 'tone';
import type { BaseTrack } from '../tracks/BaseTrack';

export class Effects {
    track: BaseTrack;

    private sourceNode?: ToneAudioNode;

    private _chorus?: Chorus;
    private _phaser?: Phaser;
    private _distortion?: Distortion;
    private _bitCrusher?: BitCrusher;
    private _autoFilter?: AutoFilter;
    private _tremolo?: Tremolo;
    private _vibrato?: Vibrato;
    private _delay?: FeedbackDelay;
    private _reverb?: Reverb;
    private _compressor?: Compressor;
    private _equalizer?: EQ3;
    private _limiter?: Limiter;

    constructor(track: BaseTrack) {
        this.track = track;
    }

    get chorus() {
        if (!this._chorus) {
            this._chorus = new Chorus().start();
            this.applyChorusParams(this._chorus, { wet: 0 });
            this.rebuildChain();
        }

        return this._chorus;
    }

    get phaser() {
        if (!this._phaser) {
            this._phaser = new Phaser();
            this.applyPhaserParams(this._phaser, { wet: 0 });
            this.rebuildChain();
        }

        return this._phaser;
    }

    get distortion() {
        if (!this._distortion) {
            this._distortion = new Distortion();
            this.applyDistortionParams(this._distortion, { wet: 0 });
            this.rebuildChain();
        }

        return this._distortion;
    }

    get bitCrusher() {
        if (!this._bitCrusher) {
            this._bitCrusher = new BitCrusher(8);
            this.applyBitCrusherParams(this._bitCrusher, { wet: 0 });
            this.rebuildChain();
        }

        return this._bitCrusher;
    }

    get autoFilter() {
        if (!this._autoFilter) {
            this._autoFilter = new AutoFilter().start();
            this.applyAutoFilterParams(this._autoFilter, { wet: 0 });
            this.rebuildChain();
        }

        return this._autoFilter;
    }

    get tremolo() {
        if (!this._tremolo) {
            this._tremolo = new Tremolo().start();
            this.applyTremoloParams(this._tremolo, { wet: 0 });
            this.rebuildChain();
        }

        return this._tremolo;
    }

    get vibrato() {
        if (!this._vibrato) {
            this._vibrato = new Vibrato();
            this.applyVibratoParams(this._vibrato, { wet: 0 });
            this.rebuildChain();
        }

        return this._vibrato;
    }

    get delay() {
        if (!this._delay) {
            this._delay = new FeedbackDelay();
            this.applyDelayParams(this._delay, { wet: 0 });
            this.rebuildChain();
        }

        return this._delay;
    }

    get reverb() {
        if (!this._reverb) {
            this._reverb = new Reverb();
            this.applyReverbParams(this._reverb, { wet: 0 });
            this.rebuildChain();
        }

        return this._reverb;
    }

    get compressor() {
        if (!this._compressor) {
            this._compressor = new Compressor();
            this.applyCompressorParams(this._compressor, { threshold: -24, ratio: 12, attack: 0.003, release: 0.25 });
            this.rebuildChain();
        }

        return this._compressor;
    }

    get equalizer() {
        if (!this._equalizer) {
            this._equalizer = new EQ3();
            this.applyEqualizerParams(this._equalizer, { low: 0, mid: 0, high: 0 });
            this.rebuildChain();
        }

        return this._equalizer;
    }

    get limiter() {
        if (!this._limiter) {
            this._limiter = new Limiter(-1);
            this.applyLimiterParams(this._limiter, -1);
            this.rebuildChain();
        }

        return this._limiter;
    }

    connect(node: ToneAudioNode) {
        this.sourceNode = node;
        this.rebuildChain();
    }

    dispose() {
        this._chorus?.dispose();
        this._phaser?.dispose();
        this._distortion?.dispose();
        this._bitCrusher?.dispose();
        this._autoFilter?.dispose();
        this._tremolo?.dispose();
        this._vibrato?.dispose();
        this._delay?.dispose();
        this._reverb?.dispose();
        this._compressor?.dispose();
        this._equalizer?.dispose();
        this._limiter?.dispose();
    }

    setChorus(p: Partial<ChorusParams>): void {
        this.applyChorusParams(this.chorus, p);
    }

    setPhaser(p: Partial<PhaserParams>): void {
        this.applyPhaserParams(this.phaser, p);
    }

    setDistortion(p: Partial<DistortionParams>): void {
        this.applyDistortionParams(this.distortion, p);
    }

    setBitCrusher(p: Partial<BitCrusherParams>): void {
        this.applyBitCrusherParams(this.bitCrusher, p);
    }

    setAutoFilter(p: Partial<AutoFilterParams>): void {
        this.applyAutoFilterParams(this.autoFilter, p);
    }

    setTremolo(p: Partial<TremoloParams>): void {
        this.applyTremoloParams(this.tremolo, p);
    }

    setVibrato(p: Partial<VibratoParams>): void {
        this.applyVibratoParams(this.vibrato, p);
    }

    setDelay(p: Partial<DelayParams>): void {
        this.applyDelayParams(this.delay, p);
    }

    setReverb(p: Partial<ReverbParams>): void {
        this.applyReverbParams(this.reverb, p);
    }

    setCompressor(p: Partial<CompressorParams>): void {
        this.applyCompressorParams(this.compressor, p);
    }

    setEqualizer(p: Partial<EqualizerParams>): void {
        this.applyEqualizerParams(this.equalizer, p);
    }

    setLimiter(db: number): void {
        this.applyLimiterParams(this.limiter, db);
    }

    private rebuildChain() {
        if (!this.sourceNode) {
            return;
        }

        this.track.audioController.disconnect();
        this.sourceNode.disconnect();

        const effectNodes: ToneAudioNode[] = [];

        if (this._chorus) effectNodes.push(this._chorus);
        if (this._phaser) effectNodes.push(this._phaser);
        if (this._distortion) effectNodes.push(this._distortion);
        if (this._bitCrusher) effectNodes.push(this._bitCrusher);
        if (this._autoFilter) effectNodes.push(this._autoFilter);
        if (this._tremolo) effectNodes.push(this._tremolo);
        if (this._vibrato) effectNodes.push(this._vibrato);
        if (this._delay) effectNodes.push(this._delay);
        if (this._reverb) effectNodes.push(this._reverb);
        if (this._compressor) effectNodes.push(this._compressor);
        if (this._equalizer) effectNodes.push(this._equalizer);
        if (this._limiter) effectNodes.push(this._limiter);

        connectSeries(this.sourceNode, ...effectNodes, this.track.audioController);
    }

    private applyChorusParams(node: Chorus, p: Partial<ChorusParams>) {
        if (p.frequency !== undefined) node.frequency.value = p.frequency;
        if (p.delayTime !== undefined) node.delayTime = p.delayTime;
        if (p.depth !== undefined) node.depth = p.depth;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyPhaserParams(node: Phaser, p: Partial<PhaserParams>) {
        if (p.frequency !== undefined) node.frequency.value = p.frequency;
        if (p.octaves !== undefined) node.octaves = p.octaves;
        if (p.baseFrequency !== undefined) node.baseFrequency = p.baseFrequency;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyDistortionParams(node: Distortion, p: Partial<DistortionParams>) {
        if (p.distortion !== undefined) node.distortion = p.distortion;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyBitCrusherParams(node: BitCrusher, p: Partial<BitCrusherParams>) {
        if (p.bits !== undefined) node.bits.value = p.bits;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyAutoFilterParams(node: AutoFilter, p: Partial<AutoFilterParams>) {
        if (p.frequency !== undefined) node.frequency.value = p.frequency;
        if (p.depth !== undefined) node.depth.value = p.depth;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyTremoloParams(node: Tremolo, p: Partial<TremoloParams>) {
        if (p.frequency !== undefined) node.frequency.value = p.frequency;
        if (p.depth !== undefined) node.depth.value = p.depth;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyVibratoParams(node: Vibrato, p: Partial<VibratoParams>) {
        if (p.frequency !== undefined) node.frequency.value = p.frequency;
        if (p.depth !== undefined) node.depth.value = p.depth;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyDelayParams(node: FeedbackDelay, p: Partial<DelayParams>) {
        if (p.delayTime !== undefined) node.delayTime.value = p.delayTime;
        if (p.feedback !== undefined) node.feedback.value = p.feedback;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyReverbParams(node: Reverb, p: Partial<ReverbParams>) {
        if (p.decay !== undefined) node.decay = p.decay;
        if (p.preDelay !== undefined) node.preDelay = p.preDelay;
        if (p.wet !== undefined) node.wet.value = p.wet;
    }

    private applyCompressorParams(node: Compressor, p: Partial<CompressorParams>) {
        if (p.threshold !== undefined) node.threshold.value = p.threshold;
        if (p.ratio !== undefined) node.ratio.value = p.ratio;
        if (p.attack !== undefined) node.attack.value = p.attack;
        if (p.release !== undefined) node.release.value = p.release;
    }

    private applyEqualizerParams(node: EQ3, p: Partial<EqualizerParams>) {
        if (p.low !== undefined) node.low.value = p.low;
        if (p.mid !== undefined) node.mid.value = p.mid;
        if (p.high !== undefined) node.high.value = p.high;
    }

    private applyLimiterParams(node: Limiter, db: number) {
        node.threshold.rampTo(db, 0.05);
    }
}

export interface ChorusParams {
    frequency: number;
    delayTime: number;
    depth: number;
    wet: number;
}

export interface PhaserParams {
    frequency: number;
    octaves: number;
    baseFrequency: number;
    wet: number;
}

export interface DistortionParams {
    distortion: number;
    wet: number;
}

export interface BitCrusherParams {
    bits: number;
    wet: number;
}

export interface AutoFilterParams {
    frequency: number;
    depth: number;
    wet: number;
}

export interface TremoloParams {
    frequency: number;
    depth: number;
    wet: number;
}

export interface VibratoParams {
    frequency: number;
    depth: number;
    wet: number;
}

export interface DelayParams {
    delayTime: Unit.Time;
    feedback: number;
    wet: number;
}

export interface ReverbParams {
    decay: Unit.Time;
    preDelay: number;
    wet: number;
}

export interface CompressorParams {
    threshold: number;
    ratio: number;
    attack: number;
    release: number;
}

export interface EqualizerParams {
    low: number;
    mid: number;
    high: number;
}
