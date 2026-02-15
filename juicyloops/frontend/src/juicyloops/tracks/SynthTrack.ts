import { PanVol, Synth } from 'tone';
import type { Engine } from '../engine';
import { BaseTrack } from './BaseTrack';

export type SynthTickSettings = {
    isActive: boolean;
    note: string;
    duration: string;
    volume: number;
};

export class SynthTrack extends BaseTrack {
    type = 'synth';

    audioController: PanVol;

    synth: Synth;

    ticks: SynthTickSettings[] = [];

    constructor(engine: Engine) {
        super(engine);

        for (let i = 0; i < 32; i++) {
            this.ticks.push({
                isActive: false,
                note: `C5`,
                duration: '12n',
                volume: 1,
            });
        }

        this.audioController = new PanVol(0, 0).toDestination();
        this.audioController.connect(this.engine.audioStream);

        this.synth = new Synth().connect(this.audioController);
    }

    play(step: number, time: number) {
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
        this.audioController.dispose();
    }
}
