export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const MIN_OCTAVE = 0;
export const MAX_OCTAVE = 10;

export const OCTAVES = Array.from({ length: MAX_OCTAVE - MIN_OCTAVE + 1 }, (_, i) => MIN_OCTAVE + i);

/** Every note from C0 to B10, ordered from the highest to the lowest (the order a piano roll displays them in). */
export const ALL_NOTES_DESCENDING = OCTAVES.flatMap((octave) => NOTE_NAMES.map((note) => `${note}${octave}`)).reverse();

const NOTE_PATTERN = /^([A-G]#?)(\d+)$/;

/** Splits "C#4" into its name and octave. Returns null if the string is not a note we understand. */
export const parseNote = (note: string): { name: string; octave: number } | null => {
    const match = note.match(NOTE_PATTERN);
    if (!match) {
        return null;
    }

    return { name: match[1]!, octave: parseInt(match[2]!, 10) };
};

/** Moves a note up or down by `direction` octaves, clamped to the supported range. Unknown notes are returned untouched. */
export const shiftOctave = (note: string, direction: number): string => {
    const parsed = parseNote(note);
    if (!parsed) {
        return note;
    }

    const octave = Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, parsed.octave + direction));
    return `${parsed.name}${octave}`;
};

export const OSCILLATOR_TYPES = ['sine', 'square', 'triangle', 'sawtooth'] as const;
export type OscillatorType = (typeof OSCILLATOR_TYPES)[number];

/**
 * How long a synth note rings, measured in sequencer steps (one step is a 16th).
 * The Tone value is what gets scheduled, the label is what the user reads.
 */
export const NOTE_LENGTHS = [
    { steps: 0.25, tone: '64n', label: '¼' },
    { steps: 0.5, tone: '32n', label: '½' },
    { steps: 1, tone: '16n', label: '1' },
    { steps: 2, tone: '8n', label: '2' },
    { steps: 4, tone: '4n', label: '4' },
    { steps: 8, tone: '2n', label: '8' },
] as const;

export type NoteLength = (typeof NOTE_LENGTHS)[number]['tone'];

export const DEFAULT_NOTE_LENGTH: NoteLength = '16n';

/** Position of a length in `NOTE_LENGTHS`, i.e. its rank from shortest to longest. */
export const noteLengthIndex = (length: NoteLength): number => NOTE_LENGTHS.findIndex((entry) => entry.tone === length);

/** How many sequencer steps a length covers. */
export const noteLengthSteps = (length: NoteLength): number => NOTE_LENGTHS[noteLengthIndex(length)]?.steps ?? 1;
