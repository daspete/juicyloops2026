import type { Engine } from '../engine';
import type { BaseTick } from '../ticks/BaseTick';

export class BaseTrack {
    id: string = Math.random().toString(36).substring(2, 11);

    type: string = 'base';

    engine: Engine;

    ticks: BaseTick[] = [];

    volume: number = 0;
    pan: number = 0;

    isMuted: boolean = false;

    constructor(engine: Engine) {
        this.engine = engine;
    }

    play(step: number, time: number) {
        console.log(`Playing step ${step} at time ${time} - nothing implemented yet`);
    }

    async dispose() {
        console.log('Disposing track - nothing implemented yet');
    }

    async setVolume(volume: number) {
        this.volume = volume;
        console.log(`Setting track volume to ${volume} - nothing implemented yet`);
    }

    async setPan(pan: number) {
        this.pan = pan;
        console.log(`Setting track pan to ${pan} - nothing implemented yet`);
    }

    async toggleMute() {
        this.isMuted = !this.isMuted;
        console.log(`Toggling track mute to ${this.isMuted} - nothing implemented yet`);
    }

    async serialize() {
        return {
            id: this.id,
            type: this.type,
            ticks: this.ticks.map((tick) => tick.serialize()),
            volume: this.volume,
            pan: this.pan,
        };
    }
}
