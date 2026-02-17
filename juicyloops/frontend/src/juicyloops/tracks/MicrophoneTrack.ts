import { PanVol, Player } from 'tone';
import type { Engine } from '../engine';
import { BaseTrack } from './BaseTrack';

export type MicrophoneTickSettings = {
    isActive: boolean;
    volume: number;
};

export class MicrophoneTrack extends BaseTrack {
    type = 'microphone';

    audioController: PanVol;
    player: Player;

    hasRecordedAudio: boolean = false;
    isRecording: boolean = false;

    sampleName: string | null = null;

    sampleStartTime: number = 0;
    sampleDuration: number = 0;

    ticks: MicrophoneTickSettings[] = [];

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

    setSampleName(name: string) {
        this.sampleName = name;
    }

    setSampleTimes(start: number, duration: number) {
        this.sampleStartTime = start;
        this.sampleDuration = duration;
    }

    play(step: number, time: number) {
        const tick = this.ticks[step];

        if (tick?.isActive && this.player.loaded) {
            this.player.start(time, this.sampleStartTime, this.sampleDuration);
        }
    }

    async dispose() {
        this.player.dispose();
        this.audioController.dispose();
    }
}
