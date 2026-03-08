import { Player, Recorder, UserMedia } from 'tone';
import type { Engine } from '../engine';
import { BaseTrack } from './BaseTrack';
import { MicrophoneTick } from '../ticks/MicrophoneTick';

export class MicrophoneTrack extends BaseTrack {
    type = 'microphone';

    player: Player;
    recorder!: Recorder;
    microphone!: UserMedia;

    hasRecordedAudio: boolean = false;
    isRecording: boolean = false;

    recordedAudio: Blob | null = null;
    recordedAudioObject: string | null = null;
    isMicrophoneOpen: boolean = false;

    sampleName: string | null = null;

    sampleStartTime: number = 0;
    sampleDuration: number = 0;

    isReversed: boolean = false;

    ticks: MicrophoneTick[] = [];

    constructor(engine: Engine) {
        super(engine);

        for (let i = 0; i < 32; i++) {
            this.ticks.push(new MicrophoneTick());
        }

        this.player = new Player();
        this.connect(this.player);

        this.recorder = new Recorder();
        this.microphone = new UserMedia();
        this.microphone.connect(this.recorder);
    }

    async ensureMicrophoneOpen() {
        if (this.isMicrophoneOpen) {
            return;
        }

        await this.microphone.open();
        this.isMicrophoneOpen = true;
    }

    revokeRecordedAudioObject() {
        if (!this.recordedAudioObject) {
            return;
        }

        URL.revokeObjectURL(this.recordedAudioObject);
        this.recordedAudioObject = null;
    }

    async startRecording() {
        if (this.isRecording) {
            return;
        }

        await this.ensureMicrophoneOpen();
        this.isRecording = true;

        await this.recorder.start();
    }

    async stopRecording() {
        if (!this.isRecording) {
            return;
        }

        this.recordedAudio = await this.recorder.stop();
        this.revokeRecordedAudioObject();
        this.recordedAudioObject = URL.createObjectURL(this.recordedAudio);

        const audioBuffer = await this.engine.decodeAudioData(await this.recordedAudio.arrayBuffer());

        this.player.buffer.set(audioBuffer);

        this.setSampleTimes(0, audioBuffer.duration);

        this.hasRecordedAudio = true;
        this.isRecording = false;
    }

    setSampleName(name: string) {
        this.sampleName = name;
    }

    setSampleTimes(start: number, duration: number) {
        this.sampleStartTime = start;
        this.sampleDuration = duration;
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

    toggleReverse() {
        this.isReversed = !this.isReversed;
        this.player.reverse = this.isReversed;
    }

    async dispose() {
        this.revokeRecordedAudioObject();
        this.player.dispose();
        this.recorder.dispose();
        this.microphone.dispose();
        super.dispose();
    }

    async serialize() {
        return {
            ...(await super.serialize()),
            ticks: this.ticks.map((tick) => tick.serialize()),
            sampleStartTime: this.sampleStartTime,
            sampleDuration: this.sampleDuration,
            buffer: await this.recordedAudio?.arrayBuffer(),
        };
    }
}
