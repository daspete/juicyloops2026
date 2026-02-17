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

    sampleStartTime: number = 0;
    sampleDuration: number = 0;

    ticks: SamplerTickSettings[] = [];
    arrayBuffer: ArrayBuffer | null = null;
    file: File | null = null;

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
        this.arrayBuffer = arrayBuffer;
        const audioContext = new AudioContext();
        const source = audioContext.createBufferSource();
        source.buffer = await audioContext.decodeAudioData(arrayBuffer);

        this.player.buffer.set(source.buffer);
    }

    setSampleName(name: string) {
        this.sampleName = name;
    }

    async setFile(file: File) {
        if(!file) {
            return;
        }

        this.file = file;

        return new Promise<void>((resolve) => {
            if(!this.file) {
                resolve();
                return;
            }

            this.setSampleName(file.name);

            const fileReader = new FileReader();
            fileReader.onload = async (e) => {
                const result = e.target?.result;
                if (!result) {
                    resolve();
                    return;
                }
                this.setSampleFromArrayBuffer(result as ArrayBuffer);

                resolve();
            };

            fileReader.readAsArrayBuffer(this.file);
        });
    }

    async setSampleFromUrl(url: string) {
        await this.player.load(url);
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
