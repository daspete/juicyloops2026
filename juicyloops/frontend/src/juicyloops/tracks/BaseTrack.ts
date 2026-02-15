import type { Engine } from '../engine';

export class BaseTrack {
    id: string = Math.random().toString(36).substring(2, 11);

    type: string = 'base';

    engine: Engine;

    constructor(engine: Engine) {
        this.engine = engine;
    }

    play(step: number, time: number) {
        console.log(`Playing step ${step} at time ${time} - nothing implemented yet`);
    }

    async dispose() {
        console.log('Disposing track - nothing implemented yet');
    }
}
