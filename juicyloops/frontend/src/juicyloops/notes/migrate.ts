import { STEP_COUNT } from '../constants';
import { createId } from '../ids';
import { DEFAULT_NOTE_LENGTH, noteLengthSteps, SAMPLE_ROOT_NOTE, transpose, type NoteLength } from '../notes';
import type { TrackState } from '../tracks/BaseTrack';
import type { PatternNote } from './Note';

/**
 * Sessions before notes (session file version 1) stored one tick per step instead:
 * `{ isActive, volume, note, duration }` on synth tracks, `{ isActive, volume, note }` on sample tracks, and even
 * older sample ticks a `pitch` (semitones above the root) instead of the note. The pattern length was the number of
 * ticks.
 */
export interface LegacyTick {
    isActive: boolean;
    volume: number;
    note?: string;
    duration?: NoteLength;
    pitch?: number;
}

/** A track state as saved before notes. */
export type LegacyTrackState = Omit<TrackState, 'notes' | 'length'> & { ticks: LegacyTick[] };

/**
 * The notes a row of ticks played: every active tick becomes a note on its step, with the tick's note and
 * `velocity = volume`. Synth ticks keep their length (`noteLengthSteps(duration)`), sample ticks get one step (a
 * one-shot plays its slice out anyway). Inactive ticks are dropped.
 */
export const ticksToNotes = (ticks: readonly LegacyTick[], type: TrackState['type']): PatternNote[] => {
    const isSynth = type === 'synth';
    const notes: PatternNote[] = [];
    ticks.forEach((tick, index) => {
        if (!tick?.isActive) {
            return;
        }
        notes.push({
            id: createId(),
            note: tick.note ?? (isSynth ? 'C5' : transpose(SAMPLE_ROOT_NOTE, tick.pitch ?? 0)),
            start: index,
            length: isSynth ? noteLengthSteps(tick.duration ?? DEFAULT_NOTE_LENGTH) : 1,
            velocity: typeof tick.volume === 'number' ? tick.volume : 1,
        });
    });
    return notes;
};

/** Whether a state still has ticks instead of notes. */
export const isLegacyTrackState = (state: object): state is LegacyTrackState => !Array.isArray((state as TrackState).notes) && Array.isArray((state as LegacyTrackState).ticks);

/** A track state with notes: an old one is converted (see `ticksToNotes`), a current one is returned as it is. */
export const upgradeTrackState = <T extends Pick<TrackState, 'type'>>(state: T | LegacyTrackState): T => {
    if (!isLegacyTrackState(state)) {
        return state;
    }
    const { ticks, ...rest } = state;
    return { ...rest, length: ticks.length || STEP_COUNT, notes: ticksToNotes(ticks, state.type) } as unknown as T;
};
