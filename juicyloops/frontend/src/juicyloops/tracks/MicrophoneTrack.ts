import { PanVol, Player, Recorder, UserMedia } from 'tone';
import type { Engine } from '../engine';
import { BaseTrack } from './BaseTrack';
import { MicrophoneTick } from '../ticks/MicrophoneTick';

export class MicrophoneTrack extends BaseTrack {
    type = 'microphone';

    audioController: PanVol;
    player: Player;
    recorder!: Recorder;
    microphone!: UserMedia;

    hasRecordedAudio: boolean = false;
    isRecording: boolean = false;

    recordedAudio: Blob | null = null;
    recordedAudioObject: string | null = null;

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

        this.audioController = new PanVol(0, 0).toDestination();
        this.audioController.connect(this.engine.audioStream);

        this.player = new Player();
        this.player.connect(this.audioController);

        this.recorder = new Recorder();
        this.microphone = new UserMedia();
        this.microphone.connect(this.recorder);
        this.microphone.open();
    }

    async startRecording() {
        if (this.isRecording) {
            return;
        }
        this.isRecording = true;

        await this.recorder.start();
    }

    async stopRecording() {
        if (!this.isRecording) {
            return;
        }

        this.recordedAudio = await this.recorder.stop();
        this.recordedAudioObject = URL.createObjectURL(this.recordedAudio);

        const audioContext = new AudioContext();
        const source = audioContext.createBufferSource();
        source.buffer = await audioContext.decodeAudioData(await this.recordedAudio.arrayBuffer());

        this.player.buffer.set(source.buffer);

        this.setSampleTimes(0, source.buffer.duration);

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

    async setVolume(volume: number) {
        await this.audioController.volume.rampTo(volume, 0.01);
        this.volume = volume;
    }
    async setPan(pan: number) {
        await this.audioController.pan.rampTo(pan, 0.01);
        this.pan = pan;
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
        this.player.dispose();
        this.audioController.dispose();
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
