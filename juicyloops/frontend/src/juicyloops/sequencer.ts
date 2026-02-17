import { Sequence } from 'tone';
import type { Engine } from './engine';
import type { BaseTrack } from './tracks/BaseTrack';
import { SynthTrack } from './tracks/SynthTrack';
import { SamplerTrack } from './tracks/SamplerTrack';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { MicrophoneTrack } from './tracks/MicrophoneTrack';

export class Sequencer {
    engine: Engine;

    patternCount: number = 4;
    stepCount: number = 8;

    sequence?: Sequence;

    tracks: BaseTrack[] = [];

    constructor(engine: Engine) {
        this.engine = engine;
    }

    async initialize() {
        const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
        const { currentTick } = useJuicyLoops();

        this.sequence = new Sequence(
            (time, step) => {
                console.log('Playing step', step, 'at time', time);
                currentTick.value = step;

                this.tracks.forEach((track) => {
                    track.play(step, time);
                });
            },
            bars,
            '16n',
        ).start(0);
    }

    async addSynthTrack() {
        const track = new SynthTrack(this.engine);
        this.tracks.push(track);
        return track;
    }

    async addSamplerTrack() {
        const track = new SamplerTrack(this.engine);
        this.tracks.push(track);
        return track;
    }

    async addMicrophoneTrack() {
        const track = new MicrophoneTrack(this.engine);
        this.tracks.push(track);
        return track;
    }

    async removeTrack(id: string) {
        const track = this.tracks.find((track) => track.id === id);
        if (!track) {
            return;
        }

        await track.dispose();

        this.tracks = this.tracks.filter((track) => track.id !== id);
    }
}
