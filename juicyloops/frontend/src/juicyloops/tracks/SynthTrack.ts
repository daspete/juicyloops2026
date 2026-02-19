import { Synth } from 'tone';
import type { Engine } from '../engine';
import { BaseTrack } from './BaseTrack';
import { SynthTick } from '../ticks/SynthTick';

export class SynthTrack extends BaseTrack {
    type = 'synth';

    synth: Synth;

    ticks: SynthTick[] = [];

    constructor(engine: Engine) {
        super(engine);

        for (let i = 0; i < 32; i++) {
            this.ticks.push(new SynthTick());
        }

        this.synth = new Synth();

        this.connect(this.synth);
    }

    play(step: number, time: number) {
        if (this.isMuted) {
            return;
        }

        const tick = this.ticks[step];
        if (tick?.isActive) {
            this.synth.triggerAttackRelease(tick.note, tick.duration, time, tick.volume);
        }
    }

    setSynthType(type: 'sine' | 'square' | 'triangle' | 'sawtooth') {
        this.synth.oscillator.type = type;
    }

    async dispose() {
        this.synth.dispose();

        super.dispose();
    }

    async serialize() {
        return {
            ...(await super.serialize()),
            ticks: this.ticks.map((tick) => tick.serialize()),
            synthType: this.synth.oscillator.type,
        };
    }
}
