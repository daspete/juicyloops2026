import { PanVol, ToneAudioNode } from 'tone';
import type { Engine } from '../engine';
import type { BaseTick } from '../ticks/BaseTick';
import { Effects } from '../effects/effects';

export class BaseTrack {
    id: string = Math.random().toString(36).substring(2, 11);

    type: string = 'base';

    engine: Engine;

    audioController: PanVol;

    ticks: BaseTick[] = [];

    volume: number = 0;
    pan: number = 0;

    isMuted: boolean = false;

    audioChain: ToneAudioNode[] = [];
    effects: Effects;

    constructor(engine: Engine) {
        this.engine = engine;

        this.audioController = new PanVol(0, 0);//.toDestination();
        this.effects = new Effects(this);

        // this.audioController.connect(this.engine.audioStream);
    }

    connect(node: ToneAudioNode) {
        this.effects.connect(node);
        this.audioController.toDestination();
    }

    play(step: number, time: number) {
        console.log(`Playing step ${step} at time ${time} - nothing implemented yet`);
    }

    async dispose() {
        this.audioController.dispose();
    }

    async setVolume(volume: number) {
        await this.audioController.volume.rampTo(volume, 0.01);
        this.volume = volume;
    }
    async setPan(pan: number) {
        await this.audioController.pan.rampTo(pan, 0.01);
        this.pan = pan;
    }

    async toggleMute() {
        this.isMuted = !this.isMuted;
    }

    async serialize() {
        return {
            id: this.id,
            type: this.type,
            ticks: this.ticks.map((tick) => tick.serialize()),
            volume: this.volume,
            pan: this.pan,
        };
    }
}
