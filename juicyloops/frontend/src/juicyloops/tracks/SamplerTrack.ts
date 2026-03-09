import { Player } from 'tone';
import type { Engine } from '../engine';
import { BaseTrack } from './BaseTrack';
import { SamplerTick } from '../ticks/SamplerTick';
import { nextTick } from 'vue';

const MAX_SAMPLE_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export class SamplerTrack extends BaseTrack {
    type = 'sampler';

    player: Player;

    ticks: SamplerTick[] = [];

    sampleName: string | null = null;

    isUpdatingSample: boolean = false;

    isReversed: boolean = false;

    sampleStartTime: number = 0;
    sampleDuration: number = 10;

    arrayBuffer: ArrayBuffer | null = null;
    file: File | null = null;

    constructor(engine: Engine) {
        super(engine);

        for (let i = 0; i < 32; i++) {
            this.ticks.push(new SamplerTick());
        }

        this.player = new Player();
        this.connect(this.player);
    }

    async setSampleFromArrayBuffer(arrayBuffer: ArrayBuffer) {
        this.arrayBuffer = arrayBuffer;
        const audioBuffer = await this.engine.decodeAudioData(arrayBuffer);
        this.player.buffer.set(audioBuffer);
        this.setSampleTimes(0, audioBuffer.duration);
    }

    setSampleName(name: string) {
        this.sampleName = name;
    }

    async setFile(file: File) {
        if (!file) {
            console.error('Cannot set sample file: no file provided.');
            return;
        }

        if (file.size > MAX_SAMPLE_FILE_SIZE_BYTES) {
            console.error(`Sample file is too large. Maximum supported size is ${MAX_SAMPLE_FILE_SIZE_BYTES / (1024 * 1024)}MB.`);
            return;
        }

        this.file = file;
        this.isUpdatingSample = true;

        try {
            await this.setSampleFromArrayBuffer(await file.arrayBuffer());
            await nextTick();
            this.setSampleName(file.name);
        } finally {
            this.isUpdatingSample = false;
        }
    }

    async setSampleFromUrl(url: string) {
        await this.player.load(url);
    }

    setSampleTimes(start: number, duration: number) {
        this.sampleStartTime = start;
        this.sampleDuration = duration;
    }

    toggleReverse() {
        this.isReversed = !this.isReversed;
        this.player.reverse = this.isReversed;
    }

    play(step: number, time: number) {
        if (this.isMuted) {
            return;
        }

        const tick = this.ticks[step];

        if (tick?.isActive && this.player.loaded) {
            this.player.start(time, this.sampleStartTime, this.sampleDuration);
        }
    }

    async dispose() {
        this.player.stop();
        this.player.dispose();
        this.arrayBuffer = null;
        this.file = null;
        await super.dispose();
    }

    async serialize() {
        return {
            ...(await super.serialize()),
            ticks: this.ticks.map((tick) => tick.serialize()),
            sampleName: this.sampleName,
            sampleStartTime: this.sampleStartTime,
            sampleDuration: this.sampleDuration,
            buffer: this.arrayBuffer,
        };
    }
}
