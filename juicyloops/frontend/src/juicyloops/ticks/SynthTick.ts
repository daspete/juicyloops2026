import { DEFAULT_NOTE_LENGTH, type NoteLength } from '../notes';
import { BaseTick, type TickSnapshot } from './BaseTick';

export interface SynthTickSnapshot extends TickSnapshot {
    note: string;
    duration: string;
}

export class SynthTick extends BaseTick {
    note = 'C5';
    duration: NoteLength = DEFAULT_NOTE_LENGTH;

    serialize(): SynthTickSnapshot {
        return {
            ...super.serialize(),
            note: this.note,
            duration: this.duration,
        };
    }
}
