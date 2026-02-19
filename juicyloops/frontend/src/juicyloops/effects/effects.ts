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

    chorus: Chorus;
    phaser: Phaser;
    distortion: Distortion;
    bitCrusher: BitCrusher;
    autoFilter: AutoFilter;
    tremolo: Tremolo;
    vibrato: Vibrato;
    delay: FeedbackDelay;
    reverb: Reverb;
    compressor: Compressor;
    equalizer: EQ3;
    limiter: Limiter;

    constructor(track: BaseTrack) {
        this.track = track;

        this.chorus = new Chorus().start();
        this.phaser = new Phaser();
        this.distortion = new Distortion();
        this.bitCrusher = new BitCrusher(8);
        this.autoFilter = new AutoFilter().start();
        this.tremolo = new Tremolo().start();
        this.vibrato = new Vibrato();
        this.delay = new FeedbackDelay();
        this.reverb = new Reverb();
        this.compressor = new Compressor();
        this.equalizer = new EQ3();
        this.limiter = new Limiter(-1);

        this.setChorus({ wet: 0 });
        this.setPhaser({ wet: 0 });
        this.setDistortion({ wet: 0 });
        this.setBitCrusher({ wet: 0 });
        this.setAutoFilter({ wet: 0 });
        this.setTremolo({ wet: 0 });
        this.setVibrato({ wet: 0 });
        this.setDelay({ wet: 0 });
        this.setReverb({ wet: 0 });
        this.setCompressor({ threshold: -24, ratio: 12, attack: 0.003, release: 0.25 });
        this.setEqualizer({ low: 0, mid: 0, high: 0 });
        this.setLimiter(-1);
    }

    connect(node: ToneAudioNode) {
        this.track.audioController.disconnect();
        node.disconnect();

        connectSeries(
            node,
            this.chorus,
            this.phaser,
            this.distortion,
            this.bitCrusher,
            this.autoFilter,
            this.tremolo,
            this.vibrato,
            this.delay,
            this.reverb,
            this.compressor,
            this.equalizer,
            this.limiter,
            this.track.audioController,
        );
    }

    setChorus(p: Partial<ChorusParams>): void {
        if (p.frequency !== undefined) this.chorus.frequency.value = p.frequency;
        if (p.delayTime !== undefined) this.chorus.delayTime = p.delayTime;
        if (p.depth !== undefined) this.chorus.depth = p.depth;
        if (p.wet !== undefined) this.chorus.wet.value = p.wet;
    }

    setPhaser(p: Partial<PhaserParams>): void {
        if (p.frequency !== undefined) this.phaser.frequency.value = p.frequency;
        if (p.octaves !== undefined) this.phaser.octaves = p.octaves;
        if (p.baseFrequency !== undefined) this.phaser.baseFrequency = p.baseFrequency;
        if (p.wet !== undefined) this.phaser.wet.value = p.wet;
    }

    setDistortion(p: Partial<DistortionParams>): void {
        if (p.distortion !== undefined) this.distortion.distortion = p.distortion;
        if (p.wet !== undefined) this.distortion.wet.value = p.wet;
    }

    setBitCrusher(p: Partial<BitCrusherParams>): void {
        if (p.bits !== undefined) this.bitCrusher.bits.value = p.bits;
        if (p.wet !== undefined) this.bitCrusher.wet.value = p.wet;
    }

    setAutoFilter(p: Partial<AutoFilterParams>): void {
        if (p.frequency !== undefined) this.autoFilter.frequency.value = p.frequency;
        if (p.depth !== undefined) this.autoFilter.depth.value = p.depth;
        if (p.wet !== undefined) this.autoFilter.wet.value = p.wet;
    }

    setTremolo(p: Partial<TremoloParams>): void {
        if (p.frequency !== undefined) this.tremolo.frequency.value = p.frequency;
        if (p.depth !== undefined) this.tremolo.depth.value = p.depth;
        if (p.wet !== undefined) this.tremolo.wet.value = p.wet;
    }

    setVibrato(p: Partial<VibratoParams>): void {
        if (p.frequency !== undefined) this.vibrato.frequency.value = p.frequency;
        if (p.depth !== undefined) this.vibrato.depth.value = p.depth;
        if (p.wet !== undefined) this.vibrato.wet.value = p.wet;
    }

    setDelay(p: Partial<DelayParams>): void {
        if (p.delayTime !== undefined) this.delay.delayTime.value = p.delayTime;
        if (p.feedback !== undefined) this.delay.feedback.value = p.feedback;
        if (p.wet !== undefined) this.delay.wet.value = p.wet;
    }

    setReverb(p: Partial<ReverbParams>): void {
        if (p.decay !== undefined) this.reverb.decay = p.decay;
        if (p.preDelay !== undefined) this.reverb.preDelay = p.preDelay;
        if (p.wet !== undefined) this.reverb.wet.value = p.wet;
    }

    setCompressor(p: Partial<CompressorParams>): void {
        if (p.threshold !== undefined) this.compressor.threshold.value = p.threshold;
        if (p.ratio !== undefined) this.compressor.ratio.value = p.ratio;
        if (p.attack !== undefined) this.compressor.attack.value = p.attack;
        if (p.release !== undefined) this.compressor.release.value = p.release;
    }

    setEqualizer(p: Partial<EqualizerParams>): void {
        if (p.low !== undefined) this.equalizer.low.value = p.low;
        if (p.mid !== undefined) this.equalizer.mid.value = p.mid;
        if (p.high !== undefined) this.equalizer.high.value = p.high;
    }

    setLimiter(db: number): void {
        this.limiter.threshold.rampTo(db, 0.05);
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
