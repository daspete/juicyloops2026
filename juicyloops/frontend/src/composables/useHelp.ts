import { ref } from 'vue';

/**
 * The help dialog (every shortcut) and the welcome tour (every part of the studio, step by step).
 *
 * The tour starts by itself once, on the first visit, right after the welcome screen; the help dialog can replay it.
 * Whether it was seen is remembered in localStorage. Module level state, so the shell, the dialog and the tour share it.
 */
const TOUR_KEY = 'juicyloops:tour';

const isHelpOpen = ref(false);
const isTourOpen = ref(false);

const wasTourSeen = (): boolean => {
    try {
        return localStorage.getItem(TOUR_KEY) === 'done';
    } catch {
        // Without storage there is no way to remember it, so it would start on every visit: better never.
        return true;
    }
};

const markTourSeen = (): void => {
    try {
        localStorage.setItem(TOUR_KEY, 'done');
    } catch {
        /* not remembered */
    }
};

const startTour = (): void => {
    isHelpOpen.value = false;
    isTourOpen.value = true;
};

/** Ends the tour, finished or skipped; either way it does not start by itself again. */
const endTour = (): void => {
    isTourOpen.value = false;
    markTourSeen();
};

/** Starts the tour on the first visit only. */
const startTourOnFirstVisit = (): void => {
    if (!wasTourSeen()) {
        startTour();
    }
};

export const useHelp = () => ({
    isHelpOpen,
    openHelp: (): void => {
        isHelpOpen.value = true;
    },
    toggleHelp: (): void => {
        isHelpOpen.value = !isHelpOpen.value;
    },
    isTourOpen,
    startTour,
    endTour,
    startTourOnFirstVisit,
});
