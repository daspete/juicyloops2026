import { nearestNoteLengthSteps } from '@/juicyloops/notes';
import { stepOfStart } from '@/juicyloops/notes/Note';
import type { NotePattern } from '@/juicyloops/notes/NotePattern';
import { lastCellOf, notesStartingIn } from '@/juicyloops/notes/stepView';
import { onBeforeUnmount } from 'vue';

/** The step cell at a point, also when a note bar is drawn over it. */
export const cellUnder = (clientX: number, clientY: number): HTMLElement | null => {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
        const cell = element.closest<HTMLElement>('[data-step]');
        if (cell) {
            return cell;
        }
    }
    return null;
};

/**
 * Dragging the ends of a note to change where it starts and how long it rings, in the step grid's lengths
 * (`NOTE_LENGTHS`: ¼, ½, 1, 2, 4, 8 steps). Used by the synth's step grid and by the piano roll; the drag follows the
 * row it started on. Every change goes through the pattern's note methods.
 */
export const useNoteResize = (pattern: () => NotePattern) => {
    type Resize = { edge: 'start' | 'end'; id: string; anchorY: number };
    let resize: Resize | null = null;

    const setLength = (track: NotePattern, id: string, length: number) => {
        if (track.getNote(id)?.length !== length) {
            track.updateNote(id, { length });
        }
    };

    const onMove = (event: PointerEvent) => {
        if (!resize) {
            return;
        }

        const cell = cellUnder(event.clientX, resize.anchorY);
        if (!cell) {
            return;
        }

        const track = pattern();
        const note = track.getNote(resize.id);
        if (!note) {
            return;
        }
        const step = Number(cell.dataset.step);
        const head = stepOfStart(note.start);

        if (resize.edge === 'end') {
            if (step <= head) {
                // Inside the note's own cell: the horizontal position picks a fraction of a step.
                const rect = cell.getBoundingClientRect();
                const ratio = (event.clientX - rect.left) / rect.width;
                setLength(track, note.id, ratio < 0.375 ? 0.25 : ratio < 0.75 ? 0.5 : 1);
            } else {
                setLength(track, note.id, nearestNoteLengthSteps(step - head + 1));
            }
            return;
        }

        const end = lastCellOf(note, track.length);
        const start = Math.min(step, end);
        const length = nearestNoteLengthSteps(Math.max(1, end - start + 1));

        if (start === head) {
            setLength(track, note.id, length);
            return;
        }

        // The start moved: the note now lives on another step, and takes that step over.
        track.removeNotes(notesStartingIn(track.notes, start).map((other) => other.id));
        track.updateNote(note.id, { start: start + (note.start - head), length });
    };

    const stopResize = () => {
        resize = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stopResize);
    };

    /** Starts dragging an end of the note with this id. */
    const startResize = (event: PointerEvent, edge: 'start' | 'end', id: string) => {
        if (event.button !== 0) {
            return;
        }
        resize = { edge, id, anchorY: event.clientY };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
    };

    onBeforeUnmount(stopResize);

    return { startResize };
};
