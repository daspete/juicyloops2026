import { nearestNoteLength, noteLengthSteps, type NoteLength } from '@/juicyloops/notes';
import type { BaseTick } from '@/juicyloops/ticks/BaseTick';
import { onBeforeUnmount } from 'vue';

/** A tick that sits on a note, and maybe rings for a length (synth ticks do, sample ticks play their slice out). */
export type NoteTick = BaseTick & { note: string; duration?: NoteLength };

/** How many steps a tick covers: its length, or one step without one. */
export const tickSteps = (tick: NoteTick): number => (tick.duration ? noteLengthSteps(tick.duration) : 1);

/** Last cell index a note starting at `index` covers in a pattern of `length` steps. */
export const noteEnd = (length: number, index: number, steps: number): number => Math.min(length - 1, index + Math.max(1, steps) - 1);

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
 * Dragging the ends of a note to change where it starts and how long it rings.
 * Used by the synth's step grid and by the piano roll; the drag follows the row it started on.
 */
export const useNoteResize = (ticks: () => NoteTick[]) => {
    type Resize = { edge: 'start' | 'end'; head: number; anchorY: number };
    let resize: Resize | null = null;

    const onMove = (event: PointerEvent) => {
        if (!resize) {
            return;
        }

        const cell = cellUnder(event.clientX, resize.anchorY);
        if (!cell) {
            return;
        }

        const all = ticks();
        const step = Number(cell.dataset.step);
        const tick = all[resize.head]!;

        if (resize.edge === 'end') {
            if (step <= resize.head) {
                // Inside the note's own cell: the horizontal position picks a fraction of a step.
                const rect = cell.getBoundingClientRect();
                const ratio = (event.clientX - rect.left) / rect.width;
                tick.duration = ratio < 0.375 ? '64n' : ratio < 0.75 ? '32n' : '16n';
            } else {
                tick.duration = nearestNoteLength(step - resize.head + 1);
            }
            return;
        }

        const end = noteEnd(all.length, resize.head, tickSteps(tick));
        const start = Math.min(step, end);
        const length = nearestNoteLength(Math.max(1, end - start + 1));

        if (start === resize.head) {
            tick.duration = length;
            return;
        }

        // The start moved: the note now lives on another step.
        const target = all[start]!;
        target.note = tick.note;
        target.isActive = true;
        target.duration = length;
        tick.isActive = false;
        resize.head = start;
    };

    const stopResize = () => {
        resize = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stopResize);
    };

    const startResize = (event: PointerEvent, edge: 'start' | 'end', head: number) => {
        if (event.button !== 0) {
            return;
        }
        resize = { edge, head, anchorY: event.clientY };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stopResize);
    };

    onBeforeUnmount(stopResize);

    return { startResize };
};
