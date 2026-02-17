import { getContext, getTransport, start, type BaseContext, type TransportInstance } from 'tone';
import { Sequencer } from './sequencer';

export class Engine {
    transport: TransportInstance;
    audioContext: BaseContext;
    audioStream: MediaStreamAudioDestinationNode;

    sequencer: Sequencer;

    constructor() {
        this.transport = getTransport();
        this.transport.bpm.value = 136;
        this.audioContext = getContext();
        this.audioStream = this.audioContext.createMediaStreamDestination();

        this.sequencer = new Sequencer(this);
    }

    async initialize() {
        await start();
        await this.sequencer.initialize();
    }

    async play() {
        this.transport.start();
    }

    async stop() {
        this.transport.stop();
    }

    async addTrack(type: string) {
        if (type === 'synth') {
            return await this.sequencer.addSynthTrack();
        }

        if (type === 'sampler') {
            return await this.sequencer.addSamplerTrack();
        }

        if (type === 'microphone') {
            return await this.sequencer.addMicrophoneTrack();
        }

        return null;
    }

    async removeTrack(id: string) {
        return this.sequencer.removeTrack(id);
    }

    async setBPM(bpm: number) {
        this.transport.bpm.value = bpm;
    }
}

export const engine = new Engine();
