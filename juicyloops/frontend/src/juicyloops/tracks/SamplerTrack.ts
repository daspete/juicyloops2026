import { PanVol, Player } from 'tone';
import type { Engine } from '../engine';
import { BaseTrack } from './BaseTrack';

export type SamplerTickSettings = {
    isActive: boolean;
    volume: number;
};

export class SamplerTrack extends BaseTrack {
    type = 'sampler';

    audioController: PanVol;
    player: Player;

    sampleName: string | null = null;

    ticks: SamplerTickSettings[] = [];

    constructor(engine: Engine) {
        super(engine);

        for (let i = 0; i < 32; i++) {
            this.ticks.push({
                isActive: false,
                volume: 1,
            });
        }

        this.audioController = new PanVol(0, 0).toDestination();
        this.audioController.connect(this.engine.audioStream);

        this.player = new Player();
        this.player.connect(this.audioController);
    }

    async setSampleFromArrayBuffer(arrayBuffer: ArrayBuffer) {
        const shadowPlayer = new Player();
        const buffer = await shadowPlayer.context.decodeAudioData(arrayBuffer);

        this.player.buffer.set(buffer);
    }

    setSampleName(name: string) {
        this.sampleName = name;
    }

    async setSample(url: string) {
        await this.player.load(url);
    }

    play(step: number, time: number) {
        const tick = this.ticks[step];

        if (tick?.isActive && this.player.loaded) {
            this.player.start(time);
        }
    }

    async dispose() {
        this.player.dispose();
        this.audioController.dispose();
    }
}
