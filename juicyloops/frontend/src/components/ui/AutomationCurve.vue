<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { formatValue, movePoint, removePoint, setPoint, type AutomationCurve, type AutomationParam } from '@/juicyloops/automation';

/**
 * A curve drawn over a timeline of steps, the same in the track view and the song view.
 * Click the lane to add a point, drag a point to move it, double-click it to remove it.
 * Straight lines join the points; before the first and after the last the value holds.
 * The element takes its size from its parent; steps are spread evenly over its width.
 */
const props = defineProps<{
    curve: AutomationCurve;
    totalSteps: number;
    /** Points land on multiples of this many steps. */
    snap: number;
    /** What the curve drives, for its readouts. */
    param?: AutomationParam;
    /** True when nothing can be drawn (the lane drives something that is gone). */
    disabled?: boolean;
    hint?: string;
}>();

const y = (value: number) => ((1 - value) * 100).toFixed(2);

const line = computed(() => {
    const points = props.curve.points;
    if (!points.length) {
        return '';
    }
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const inner = points.map((point) => `${point.step},${y(point.value)}`).join(' ');
    return `0,${y(first.value)} ${inner} ${props.totalSteps},${y(last.value)}`;
});

const area = computed(() => (line.value ? `0,100 ${line.value} ${props.totalSteps},100` : ''));

const pointStyle = (point: { step: number; value: number }) => ({
    left: `${(point.step / props.totalSteps) * 100}%`,
    top: `${(1 - point.value) * 100}%`,
});

const readout = (value: number) => (props.param ? formatValue(props.param, value) : `${Math.round(value * 100)}%`);

/* ---- pointer interactions ---- */

const body = ref<HTMLElement | null>(null);
const dragIndex = ref<number | null>(null);

const locate = (event: PointerEvent): { step: number; value: number } | null => {
    const rect = body.value?.getBoundingClientRect();
    if (!rect) {
        return null;
    }
    const raw = ((event.clientX - rect.left) / rect.width) * props.totalSteps;
    const step = Math.min(props.totalSteps, Math.max(0, Math.round(raw / props.snap) * props.snap));
    const value = 1 - (event.clientY - rect.top) / rect.height;
    return { step, value: Math.round(Math.min(1, Math.max(0, value)) * 100) / 100 };
};

const onMove = (event: PointerEvent) => {
    const at = locate(event);
    if (dragIndex.value !== null && at) {
        dragIndex.value = movePoint(props.curve, dragIndex.value, at.step, at.value);
    }
};

const stopDrag = () => {
    dragIndex.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stopDrag);
};

const startDrag = (index: number) => {
    dragIndex.value = index;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stopDrag);
};

/** Pressing on the lane puts a point there and picks it up right away. */
const onLaneDown = (event: PointerEvent) => {
    const at = locate(event);
    if (event.button !== 0 || !at || props.disabled) {
        return;
    }
    startDrag(setPoint(props.curve, at.step, at.value));
};

const onPointDown = (event: PointerEvent, index: number) => {
    if (event.button === 0) {
        startDrag(index);
    }
};

onBeforeUnmount(stopDrag);
</script>

<template>
    <div ref="body" class="auto-body" :data-dragging="dragIndex !== null" :data-disabled="props.disabled" @pointerdown.self="onLaneDown">
        <svg class="auto-curve" :viewBox="`0 0 ${props.totalSteps} 100`" preserveAspectRatio="none" aria-hidden="true">
            <polygon v-if="area" :points="area" class="auto-area" />
            <polyline v-if="line" :points="line" class="auto-line" vector-effect="non-scaling-stroke" />
        </svg>
        <span
            v-for="(point, index) in props.curve.points"
            :key="`${point.step}-${index}`"
            class="auto-point"
            :data-active="dragIndex === index"
            :style="pointStyle(point)"
            :title="`${readout(point.value)} at step ${point.step + 1}. Drag to move, double-click to remove.`"
            @pointerdown.stop="onPointDown($event, index)"
            @dblclick.stop="removePoint(props.curve, index)"
        >
            <span v-if="dragIndex === index" class="auto-tag">{{ readout(point.value) }}</span>
        </span>
        <span v-if="hint" class="auto-hint">{{ hint }}</span>
    </div>
</template>
