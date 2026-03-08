import { onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';
import { getCurrentTick, subscribeToCurrentTick } from './useJuicyLoops';

interface PlayheadTarget {
    selector: string;
    currentClass: string;
}

const defaultTargets: PlayheadTarget[] = [
    {
        selector: '.tick',
        currentClass: 'tick--current',
    },
    {
        selector: '.pianotick',
        currentClass: 'pianotick--current',
    },
];

export const useTrackPlayhead = (targets: PlayheadTarget[] = defaultTargets) => {
    const rootElement = ref<HTMLElement | null>(null);

    const togglePlayheadClass = (step: number, isActive: boolean) => {
        if (step < 0 || !rootElement.value) {
            return;
        }

        for (const target of targets) {
            rootElement.value
                .querySelectorAll<HTMLElement>(`${target.selector}[data-tick-index="${step}"]`)
                .forEach((element) => {
                    element.classList.toggle(target.currentClass, isActive);
                });
        }
    };

    const syncCurrentPlayhead = () => {
        togglePlayheadClass(getCurrentTick(), true);
    };

    let unsubscribe: (() => void) | undefined;

    onMounted(() => {
        unsubscribe = subscribeToCurrentTick((step, previousStep) => {
            if (previousStep !== step) {
                togglePlayheadClass(previousStep, false);
            }

            togglePlayheadClass(step, true);
        });
    });

    onUpdated(() => {
        syncCurrentPlayhead();
    });

    onBeforeUnmount(() => {
        unsubscribe?.();
        togglePlayheadClass(getCurrentTick(), false);
    });

    return {
        rootElement,
    };
};
