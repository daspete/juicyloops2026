import { readonly, ref } from 'vue';

/**
 * Which kind of screen the app is on, so the shell can move its controls around.
 *
 * A phone keeps the navigation at the bottom, within reach of a thumb, and drops what a touch screen has no use for
 * (keyboard hints, hover-only affordances). The breakpoint matches the phone block in globals.css.
 * Module level state, so every component sees the same answer and only one listener runs for the life of the page.
 */
export const PHONE_QUERY = '(max-width: 47.9rem)';

const isPhone = ref(false);

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const list = window.matchMedia(PHONE_QUERY);
    const update = () => {
        isPhone.value = list.matches;
    };
    update();
    list.addEventListener('change', update);
}

export const useViewport = () => ({
    isPhone: readonly(isPhone),
});
