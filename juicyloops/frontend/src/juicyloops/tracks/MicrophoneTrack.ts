import { Recorder, UserMedia } from 'tone';
import { markRaw } from 'vue';
import { SampleTrack } from './SampleTrack';

/** Records a sample from the microphone and plays it back like a sampler. */
export class MicrophoneTrack extends SampleTrack {
    readonly type = 'microphone';

    private readonly recorder = markRaw(new Recorder());
    private readonly microphone = markRaw(new UserMedia());

    isRecording = false;

    constructor() {
        super();

        this.microphone.connect(this.recorder);
        this.microphone.open().catch((error) => console.warn('Could not open the microphone', error));
    }

    async startRecording(): Promise<void> {
        if (this.isRecording) {
            return;
        }

        this.isRecording = true;
        await this.recorder.start();
    }

    async stopRecording(): Promise<void> {
        if (!this.isRecording) {
            return;
        }

        try {
            const recording = await this.recorder.stop();
            await this.loadSample(recording, 'Recording');
        } finally {
            this.isRecording = false;
        }
    }

    async toggleRecording(): Promise<void> {
        if (this.isRecording) {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    dispose(): void {
        this.recorder.dispose();
        this.microphone.dispose();
        super.dispose();
    }
}
