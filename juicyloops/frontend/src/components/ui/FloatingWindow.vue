<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, ref } from 'vue';
import { fitWindow, MIN_WINDOW_WIDTH, type FloatingWindowState, type WindowArea } from './floatingWindow';

/**
 * The frame every floating window shares: a title bar in the window's colour, the content below it, grips on the
 * sides and bottom corners. Drag the title bar to move it, an edge or a corner to resize it, double-click the title
 * bar (or use its button) to fill the whole area. Pressing anywhere in the window brings it to the front.
 *
 * The caller owns the state (position, size, stacking, maximized) and says what area it floats in: `fixed` windows
 * float over the whole screen, the others over their positioned parent.
 *
 * Slots: `title` (after the colour swatch), `actions` (buttons before maximize and close), default (the content).
 */
const props = defineProps<{
    state: FloatingWindowState;
    area: WindowArea;
    /** The window's colour: the swatch and the tint of the title bar. */
    accent: string;
    label: string;
    fixed?: boolean;
}>();

const emit = defineEmits<{
    focus: [];
    close: [];
}>();

/** Fixed windows sit above the app (docks, song view windows) and below menus and tooltips. */
const FIXED_Z_BASE = 900;

const style = computed(() => {
    const zIndex = props.fixed ? FIXED_Z_BASE + props.state.z : props.state.z;
    const base = { zIndex, '--jl-win-accent': props.accent };
    return props.state.isMaximized
        ? base
        : { ...base, left: `${props.state.x}px`, top: `${props.state.y}px`, width: `${props.state.width}px`, height: `${props.state.height}px` };
});

/* The state object belongs to the caller; the frame moves, sizes and maximizes it in place. */
const toggleMaximize = () => {
    const state = props.state;
    state.isMaximized = !state.isMaximized;
};

/* ---- moving and resizing ---- */

type Edge = 'move' | 'e' | 'w' | 's' | 'se' | 'sw';

const drag = ref<{ edge: Edge; pointerId: number; startX: number; startY: number; from: Pick<FloatingWindowState, 'x' | 'y' | 'width' | 'height'> } | null>(null);

const startDrag = (event: PointerEvent, edge: Edge) => {
    if (event.button !== 0 || (edge === 'move' && props.state.isMaximized)) {
        return;
    }
    event.preventDefault();
    const { x, y, width, height } = props.state;
    drag.value = { edge, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, from: { x, y, width, height } };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};

const onDragMove = (event: PointerEvent) => {
    const current = drag.value;
    if (!current || event.pointerId !== current.pointerId) {
        return;
    }
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    const { from, edge } = current;
    const state = props.state;

    if (edge === 'move') {
        state.x = from.x + dx;
        state.y = from.y + dy;
    } else {
        if (edge.includes('e')) {
            state.width = from.width + dx;
        }
        if (edge.includes('w')) {
            // The right edge stays put: the left one follows the pointer as far as the minimum width allows.
            const right = from.x + from.width;
            state.x = Math.min(Math.max(0, from.x + dx), right - MIN_WINDOW_WIDTH);
            state.width = right - state.x;
        }
        if (edge.includes('s')) {
            state.height = from.height + dy;
        }
    }
    fitWindow(state, props.area);
};

const endDrag = (event: PointerEvent) => {
    if (drag.value?.pointerId === event.pointerId) {
        drag.value = null;
    }
};

/** The title bar moves the window, except where it has a control of its own. */
const isControl = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest('button, input');

const onBarDown = (event: PointerEvent) => {
    if (!isControl(event.target)) {
        startDrag(event, 'move');
    }
};

const onBarDoubleClick = (event: MouseEvent) => {
    if (!isControl(event.target)) {
        toggleMaximize();
    }
};

const EDGES: readonly Exclude<Edge, 'move'>[] = ['e', 'w', 's', 'se', 'sw'];
</script>

<template>
    <section
        class="fwin"
        :class="{ 'fwin--maximized': props.state.isMaximized, 'fwin--dragging': drag, 'fwin--fixed': props.fixed }"
        :style="style"
        role="dialog"
        :aria-label="props.label"
        @pointerdown.capture="emit('focus')"
    >
        <header class="fwin-bar" @pointerdown="onBarDown" @pointermove="onDragMove" @pointerup="endDrag" @pointercancel="endDrag" @dblclick="onBarDoubleClick">
            <span class="fwin-swatch" aria-hidden="true"></span>
            <slot name="title" />
            <span class="flex-1"></span>
            <slot name="actions" />
            <button
                type="button"
                class="iconbtn iconbtn--tiny"
                :aria-label="props.state.isMaximized ? 'Restore window' : 'Maximize window'"
                v-tooltip.bottom="props.state.isMaximized ? 'Restore' : 'Maximize'"
                @click="toggleMaximize"
            >
                <Icon :icon="props.state.isMaximized ? 'mdi:window-restore' : 'mdi:window-maximize'" class="w-3.5 h-3.5" />
            </button>
            <button type="button" class="iconbtn iconbtn--tiny" aria-label="Close window" v-tooltip.bottom="'Close'" @click="emit('close')">
                <Icon icon="mdi:close" class="w-3.5 h-3.5" />
            </button>
        </header>

        <div class="fwin-body">
            <slot />
        </div>

        <template v-if="!props.state.isMaximized">
            <span
                v-for="edge in EDGES"
                :key="edge"
                class="fwin-edge"
                :class="`fwin-edge--${edge}`"
                aria-hidden="true"
                @pointerdown="startDrag($event, edge)"
                @pointermove="onDragMove"
                @pointerup="endDrag"
                @pointercancel="endDrag"
            ></span>
        </template>
    </section>
</template>
