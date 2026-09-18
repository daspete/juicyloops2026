<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

/**
 * A knob that behaves like the ones in DAWs and hardware editors:
 *  - drag up or down (not around the circle) to change the value,
 *  - hold Shift while dragging for fine control,
 *  - scroll the mouse wheel over it,
 *  - use the arrow keys when focused, Home/End jump to the ends,
 *  - double-click to reset.
 * `curve: 'log'` spreads small values out, which is what you want for times and frequencies.
 */
const props = withDefaults(
    defineProps<{
        modelValue: number;
        min: number;
        max: number;
        step?: number;
        label: string;
        hint?: string;
        size?: number;
        curve?: 'linear' | 'log';
        /** Value restored on double-click. Defaults to the value the knob was created with. */
        resetValue?: number;
        format?: (value: number) => string;
    }>(),
    { step: 0.01, size: 56, curve: 'linear' },
);

const emit = defineEmits<{
    'update:modelValue': [value: number];
}>();

/** Pixels of vertical drag for a full sweep from min to max. */
const DRAG_RANGE_PX = 160;
const FINE_FACTOR = 0.1;
const WHEEL_STEP = 0.03;

const initialValue = props.modelValue;
const isDragging = ref(false);
const isHovered = ref(false);

const decimals = Math.max(0, Math.ceil(-Math.log10(props.step)));
const clamp = (value: number) => Math.min(props.max, Math.max(props.min, value));
const quantize = (value: number) => parseFloat((Math.round(value / props.step) * props.step).toFixed(decimals));

/* Normalised position 0..1 along the knob's sweep. */
const toPosition = (value: number): number => {
    const v = clamp(value);
    if (props.curve === 'log' && props.min > 0) {
        return Math.log(v / props.min) / Math.log(props.max / props.min);
    }
    return (v - props.min) / (props.max - props.min);
};

const fromPosition = (position: number): number => {
    const t = Math.min(1, Math.max(0, position));
    const raw = props.curve === 'log' && props.min > 0 ? props.min * Math.pow(props.max / props.min, t) : props.min + t * (props.max - props.min);
    return clamp(quantize(raw));
};

const set = (value: number) => {
    const next = clamp(quantize(value));
    if (next !== props.modelValue) {
        emit('update:modelValue', next);
    }
};

const position = computed(() => toPosition(props.modelValue));

const display = computed(() => (props.format ? props.format(props.modelValue) : props.modelValue.toFixed(decimals)));

/* ---- dragging ---- */

let dragStartY = 0;
let dragStartPosition = 0;

const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
        return;
    }
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    (event.currentTarget as HTMLElement).focus();
    isDragging.value = true;
    dragStartY = event.clientY;
    dragStartPosition = position.value;
};

const onPointerMove = (event: PointerEvent) => {
    if (!isDragging.value) {
        return;
    }
    const factor = event.shiftKey ? FINE_FACTOR : 1;
    const delta = ((dragStartY - event.clientY) / DRAG_RANGE_PX) * factor;
    set(fromPosition(dragStartPosition + delta));
};

const onPointerUp = (event: PointerEvent) => {
    if (!isDragging.value) {
        return;
    }
    isDragging.value = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
};

/* Re-anchor when Shift is pressed or released mid-drag so the value does not jump. */
const onKeyToggle = (event: KeyboardEvent) => {
    if (event.key === 'Shift' && isDragging.value) {
        dragStartPosition = position.value;
        dragStartY = lastClientY;
    }
};
let lastClientY = 0;
const trackPointer = (event: PointerEvent) => (lastClientY = event.clientY);
window.addEventListener('keydown', onKeyToggle);
window.addEventListener('keyup', onKeyToggle);
onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyToggle);
    window.removeEventListener('keyup', onKeyToggle);
});

const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    const factor = event.shiftKey ? FINE_FACTOR : 1;
    set(fromPosition(position.value + direction * WHEEL_STEP * factor));
};

const onKeyDown = (event: KeyboardEvent) => {
    const big = event.shiftKey ? 10 : 1;
    const actions: Record<string, () => void> = {
        ArrowUp: () => set(props.modelValue + props.step * big),
        ArrowRight: () => set(props.modelValue + props.step * big),
        ArrowDown: () => set(props.modelValue - props.step * big),
        ArrowLeft: () => set(props.modelValue - props.step * big),
        PageUp: () => set(fromPosition(position.value + 0.1)),
        PageDown: () => set(fromPosition(position.value - 0.1)),
        Home: () => set(props.min),
        End: () => set(props.max),
    };
    const action = actions[event.key];
    if (action) {
        event.preventDefault();
        action();
    }
};

const reset = () => set(props.resetValue ?? initialValue);

/* ---- drawing: a 270° arc that starts bottom-left and ends bottom-right ---- */

const STROKE = 5;
const SWEEP = 270;
const START_ANGLE = 135;

const radius = computed(() => props.size / 2 - STROKE);
const centre = computed(() => props.size / 2);

const polar = (angleDegrees: number, r: number) => {
    const radians = ((angleDegrees + 90) * Math.PI) / 180;
    return { x: centre.value + r * Math.cos(radians), y: centre.value + r * Math.sin(radians) };
};

const arcPath = computed(() => {
    const start = polar(START_ANGLE, radius.value);
    const end = polar(START_ANGLE + SWEEP, radius.value);
    return `M ${start.x} ${start.y} A ${radius.value} ${radius.value} 0 1 1 ${end.x} ${end.y}`;
});

const pointer = computed(() => polar(START_ANGLE + SWEEP * position.value, radius.value));

const tooltip = computed(() => props.hint ?? 'Drag up or down. Hold Shift for fine control. Double-click to reset.');
</script>

<template>
    <div class="knob" :class="{ 'knob--dragging': isDragging }" :style="{ width: `${size}px` }">
        <div
            class="knob-dial"
            role="slider"
            tabindex="0"
            :aria-label="label"
            :aria-valuemin="min"
            :aria-valuemax="max"
            :aria-valuenow="modelValue"
            :aria-valuetext="display"
            v-tooltip.bottom="{ value: tooltip, showDelay: 600 }"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove($event), trackPointer($event)"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @pointerenter="isHovered = true"
            @pointerleave="isHovered = false"
            @wheel="onWheel"
            @keydown="onKeyDown"
            @dblclick="reset"
        >
            <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" aria-hidden="true">
                <path :d="arcPath" class="knob-track" :stroke-width="STROKE" />
                <path :d="arcPath" class="knob-value" :stroke-width="STROKE" pathLength="1" :stroke-dasharray="`${position} 1`" />
                <circle :cx="pointer.x" :cy="pointer.y" :r="STROKE * 0.8" class="knob-pointer" />
            </svg>
            <div class="knob-readout">{{ display }}</div>
        </div>
        <div class="knob-label">{{ label }}</div>
    </div>
</template>
