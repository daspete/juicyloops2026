import { BaseTick } from './BaseTick';

export class SynthTick extends BaseTick {
    note: string = 'C5';
    duration: string = '12n';

    serialize() {
        return {
            ...super.serialize(),
            note: this.note,
            duration: this.duration,
        };
    }
}
