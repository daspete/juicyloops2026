import type { Engine } from '../engine';
import type { BaseTick } from '../ticks/BaseTick';

export class BaseTrack {
    id: string = Math.random().toString(36).substring(2, 11);

    type: string = 'base';

    engine: Engine;

    ticks: BaseTick[] = [];

    constructor(engine: Engine) {
        this.engine = engine;
    }

    play(step: number, time: number) {
        console.log(`Playing step ${step} at time ${time} - nothing implemented yet`);
    }

    async dispose() {
        console.log('Disposing track - nothing implemented yet');
    }

    async serialize() {
        return {
            id: this.id,
            type: this.type,
            ticks: this.ticks.map((tick) => tick.serialize()),
        };
    }
}
