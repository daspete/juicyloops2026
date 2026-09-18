import { onBeforeUnmount } from 'vue';

export interface HoldRepeatOptions {
    /** Milliseconds before repeating starts. */
    delay?: number;
    /** Milliseconds between repeats. */
    interval?: number;
    /** After this many milliseconds of holding, repeats switch to `fastInterval`. */
    fastAfter?: number;
    fastInterval?: number;
}

/**
 * Press-and-hold behaviour for stepper buttons: the action runs once on press,
 * repeats while the pointer stays down, and speeds up after a while.
 * Keyboard activation (Enter/Space) still runs the action once through the click event.
 *
 * Spread the returned listeners onto the button with `v-on`.
 */
export const useHoldRepeat = (action: () => void, options: HoldRepeatOptions = {}) => {
    const { delay = 400, interval = 80, fastAfter = 1500, fastInterval = 30 } = options;

    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let ticker: ReturnType<typeof setInterval> | null = null;
    let pressedAt = 0;

    const stop = () => {
        if (startTimer) {
            clearTimeout(startTimer);
            startTimer = null;
        }
        if (ticker) {
            clearInterval(ticker);
            ticker = null;
        }
    };

    const tick = () => {
        action();
        if (ticker && Date.now() - pressedAt > fastAfter) {
            clearInterval(ticker);
            ticker = setInterval(action, fastInterval);
        }
    };

    const start = (event: PointerEvent) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        stop();
        pressedAt = Date.now();
        action();
        startTimer = setTimeout(() => (ticker = setInterval(tick, interval)), delay);
    };

    onBeforeUnmount(stop);

    return {
        pointerdown: start,
        pointerup: stop,
        pointerleave: stop,
        pointercancel: stop,
        /** Pointer presses are handled above; a click with `detail === 0` comes from the keyboard. */
        click: (event: MouseEvent) => event.detail === 0 && action(),
    };
};
