import { onBeforeUnmount, watch, type Ref } from 'vue';
import type { TrackPlayhead } from '@/composables/useContainerView';
import { useJuicyLoops } from '@/composables/useJuicyLoops';

/**
 * The piano roll's playhead: a beam at the fractional play position, moved every frame straight on the DOM.
 *
 * The transport reports whole steps (`playhead.currentTick`, the step inside the track's pattern). Between two steps
 * the beam glides on at the tempo, so it sits where the audio is, not where the last step began. Nothing reactive
 * changes per frame: only the beam's `transform` is written, so no note bar re-renders while the song plays.
 * The playhead refs are read only while the roll is open.
 */
export const useRollBeam = (options: {
    open: () => boolean;
    playhead: TrackPlayhead;
    /** Pixels per step. */
    stepWidth: () => number;
    /** The pattern's length in steps: the beam never glides past the end. */
    length: () => number;
    /** The elements that follow the play position (the beam through the notes, the marker in the ruler). */
    beams: Readonly<Ref<HTMLElement | null>>[];
}) => {
    const { bpm } = useJuicyLoops();

    let tick = -1;
    let tickAt = 0;
    let frame = 0;

    /** Where the audio is right now, in steps inside the pattern; -1 while stopped. */
    const position = (): number => {
        if (tick < 0) {
            return -1;
        }
        const secondsPerStep = 15 / bpm.value;
        const into = (performance.now() - tickAt) / 1000 / secondsPerStep;
        // Never run into the next step before the transport says so: a late step would make the beam jump back.
        return Math.min(tick + Math.min(0.999, into), options.length());
    };

    const paint = () => {
        const at = position();
        const x = at * options.stepWidth();
        for (const beam of options.beams) {
            const element = beam.value;
            if (element) {
                element.style.transform = `translateX(${x}px)`;
                element.hidden = at < 0;
            }
        }
    };

    const loop = () => {
        paint();
        frame = tick >= 0 ? requestAnimationFrame(loop) : 0;
    };

    const stop = () => {
        if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
        }
    };

    watch(
        () => (options.open() ? options.playhead.currentTick.value : -1),
        (next) => {
            tick = next;
            tickAt = performance.now();
            if (next >= 0 && !frame) {
                frame = requestAnimationFrame(loop);
            } else if (next < 0) {
                stop();
                paint();
            }
        },
        { immediate: true, flush: 'sync' },
    );

    onBeforeUnmount(stop);

    return { position, paint };
};
