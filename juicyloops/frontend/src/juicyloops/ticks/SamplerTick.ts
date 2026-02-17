import { BaseTick } from './BaseTick';

export class SamplerTick extends BaseTick {
    pitch: number = 0;

    serialize() {
        return {
            ...super.serialize(),
            pitch: this.pitch,
        };
    }
}
