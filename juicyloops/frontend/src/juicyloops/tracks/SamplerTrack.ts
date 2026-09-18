import { SampleTrack } from './SampleTrack';

/** Plays a user supplied audio file. */
export class SamplerTrack extends SampleTrack {
    readonly type = 'sampler';

    /** True while a newly selected file is being decoded. */
    isUpdatingSample = false;

    async setFile(file: File): Promise<void> {
        this.isUpdatingSample = true;

        try {
            await this.loadSample(file, file.name);
        } finally {
            this.isUpdatingSample = false;
        }
    }

    async setSampleFromUrl(url: string): Promise<void> {
        await this.player.load(url);
        this.setSampleTimes(0, this.player.buffer.duration);
        this.hasSample = true;
    }
}
