import { onMounted, onUpdated, watch, type Ref } from 'vue';

/**
 * Keeps a class on the cells the playhead is on, written straight onto the DOM.
 *
 * The playhead moves every step. Bound in a template, it would re-render a whole row of cells (with their slots)
 * that often, just to move one class. Here only the class moves. `targets` returns selectors, relative to `root`,
 * for the cells that should carry the class right now; it is watched, so any reactive state it reads (the playhead)
 * is tracked. The class is put back after the component re-renders for other reasons, because Vue rewrites
 * `class` on the cells whose own classes changed.
 */
export const usePlayheadClass = (root: Readonly<Ref<HTMLElement | null>>, className: string, targets: () => readonly string[]): void => {
    let marked: Element[] = [];

    const paint = (selectors: readonly string[]): void => {
        for (const cell of marked) {
            cell.classList.remove(className);
        }
        marked = [];
        const element = root.value;
        if (!element) {
            return;
        }
        for (const selector of selectors) {
            element.querySelectorAll(selector).forEach((cell) => {
                cell.classList.add(className);
                marked.push(cell);
            });
        }
    };

    watch(targets, paint, { flush: 'post' });
    onMounted(() => paint(targets()));
    onUpdated(() => paint(targets()));
};
