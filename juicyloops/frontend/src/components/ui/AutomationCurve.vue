<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
    CURVE_SHAPES,
    formatValue,
    movePoint,
    removePoint,
    segmentValue,
    setPoint,
    setSegment,
    type AutomationCurve,
    type AutomationParam,
    type AutomationPoint,
    type CurveShape,
} from '@/juicyloops/automation';
import SongMenu, { type SongMenuItem } from '../song/SongMenu.vue';

/**
 * A curve drawn over a timeline of steps, the same in the track view and the song view.
 * Click the lane to add a point, drag a point to move it, double-click it to remove it.
 *
 * Every segment between two points has a handle. Drag it up or down to bend the segment, double-click it to make the
 * segment straight again, right-click it to pick the segment's shape: a curve that bends towards either end, an
 * S-curve that shapes both ends at once, or a hold that keeps the value and jumps at the next point.
 * Before the first point and after the last the value holds.
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

/** Line pieces a shaped segment is drawn with. */
const SAMPLES = 32;

const y = (value: number) => ((1 - value) * 100).toFixed(2);

const line = computed(() => {
    const points = props.curve.points;
    if (!points.length) {
        return '';
    }
    const coords: string[] = [`0,${y(points[0]!.value)}`];
    points.forEach((from, index) => {
        coords.push(`${from.step},${y(from.value)}`);
        const to = points[index + 1];
        if (!to) {
            return;
        }
        if (from.shape === 'hold') {
            coords.push(`${to.step},${y(from.value)}`);
        } else if (from.tension) {
            const span = to.step - from.step;
            for (let sample = 1; sample < SAMPLES; sample++) {
                const step = from.step + (span * sample) / SAMPLES;
                coords.push(`${step.toFixed(3)},${y(segmentValue(from, to, step))}`);
            }
        }
    });
    coords.push(`${props.totalSteps},${y(points[points.length - 1]!.value)}`);
    return coords.join(' ');
});

const area = computed(() => (line.value ? `0,100 ${line.value} ${props.totalSteps},100` : ''));

const pointStyle = (point: { step: number; value: number }) => ({
    left: `${(point.step / props.totalSteps) * 100}%`,
    top: `${(1 - point.value) * 100}%`,
});

const readout = (value: number) => (props.param ? formatValue(props.param, value) : `${Math.round(value * 100)}%`);

/* ---- segment handles ---- */

interface Segment {
    index: number;
    from: AutomationPoint;
    to: AutomationPoint;
    shape: CurveShape;
    /** Where the handle sits: on the curve, where bending it shows most. */
    step: number;
    value: number;
}

/** An S-curve passes the middle at half height whatever its tension, so its handle sits a quarter of the way in. */
const handleAt = (shape: CurveShape) => (shape === 's-curve' ? 0.25 : 0.5);

const segments = computed<Segment[]>(() =>
    props.curve.points.flatMap((from, index) => {
        const to = props.curve.points[index + 1];
        if (!to || to.step <= from.step) {
            return [];
        }
        const shape = from.shape ?? 'curve';
        const step = from.step + (to.step - from.step) * handleAt(shape);
        return [{ index, from, to, shape, step, value: shape === 'hold' ? from.value : segmentValue(from, to, step) }];
    }),
);

const shapeLabel = (shape: CurveShape) => CURVE_SHAPES.find((item) => item.key === shape)!.label;

const segmentTag = (segment: Segment) =>
    segment.shape === 'hold' ? 'Hold' : `${shapeLabel(segment.shape)} ${Math.round((segment.from.tension ?? 0) * 100)}%`;

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

/*
 * Bending: the handle follows the pointer up and down, so dragging up lifts the segment whichever way it runs.
 * The travel does not depend on the lane's height (lanes can be short): BEND_TRAVEL pixels take a straight segment to its full bend.
 */
const BEND_TRAVEL = 120;

const bendIndex = ref<number | null>(null);
let bend: { pointerId: number; startY: number; tension: number; direction: number } | null = null;

const onHandleDown = (event: PointerEvent, segment: Segment) => {
    if (event.button !== 0 || props.disabled || segment.shape === 'hold') {
        return;
    }
    // Positive tension lowers the handle of a rising segment and lifts the handle of a falling one.
    const direction = segment.to.value >= segment.from.value ? -1 : 1;
    bend = { pointerId: event.pointerId, startY: event.clientY, tension: segment.from.tension ?? 0, direction };
    bendIndex.value = segment.index;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};

const onHandleMove = (event: PointerEvent, segment: Segment) => {
    if (!bend || event.pointerId !== bend.pointerId) {
        return;
    }
    const up = (bend.startY - event.clientY) / BEND_TRAVEL;
    setSegment(props.curve, segment.index, segment.shape, bend.tension + bend.direction * up);
};

const onHandleUp = (event: PointerEvent) => {
    if (bend?.pointerId === event.pointerId) {
        bend = null;
        bendIndex.value = null;
    }
};

const straighten = (segment: Segment) => {
    if (!props.disabled) {
        setSegment(props.curve, segment.index, segment.shape === 'hold' ? 'curve' : segment.shape, 0);
    }
};

/* The shape menu, on a right-click on a handle. */
const menu = ref<{ x: number; y: number; segment: Segment } | null>(null);

const openMenu = (event: MouseEvent, segment: Segment) => {
    if (!props.disabled) {
        menu.value = { x: event.clientX, y: event.clientY, segment };
    }
};

const menuItems = computed<SongMenuItem[]>(() => {
    const segment = menu.value?.segment;
    if (!segment) {
        return [];
    }
    const tension = segment.from.tension ?? 0;
    return [
        ...CURVE_SHAPES.map((shape) => ({
            label: shape.label,
            icon: shape.icon,
            checked: segment.shape === shape.key,
            // Switching between curve and S-curve keeps the bend; a hold has none.
            action: () => setSegment(props.curve, segment.index, shape.key, shape.key === 'hold' ? 0 : tension),
        })),
        {},
        { label: 'Straighten', icon: 'mdi:vector-line', disabled: segment.shape === 'hold' || !tension, action: () => straighten(segment) },
    ];
});

onBeforeUnmount(stopDrag);
</script>

<template>
    <div ref="body" class="auto-body" :data-dragging="dragIndex !== null || bendIndex !== null" :data-disabled="props.disabled" @pointerdown.self="onLaneDown">
        <svg class="auto-curve" :viewBox="`0 0 ${props.totalSteps} 100`" preserveAspectRatio="none" aria-hidden="true">
            <polygon v-if="area" :points="area" class="auto-area" />
            <polyline v-if="line" :points="line" class="auto-line" vector-effect="non-scaling-stroke" />
        </svg>
        <span
            v-for="segment in segments"
            :key="`segment-${segment.index}`"
            class="auto-handle"
            :data-active="bendIndex === segment.index"
            :data-shape="segment.shape"
            :style="pointStyle(segment)"
            :title="`${segmentTag(segment)}. Drag up or down to bend, double-click to straighten, right-click for the shape.`"
            @pointerdown.stop="onHandleDown($event, segment)"
            @pointermove="onHandleMove($event, segment)"
            @pointerup="onHandleUp"
            @pointercancel="onHandleUp"
            @dblclick.stop="straighten(segment)"
            @contextmenu.prevent.stop="openMenu($event, segment)"
        >
            <span v-if="bendIndex === segment.index" class="auto-tag">{{ segmentTag(segment) }}</span>
        </span>
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

        <Teleport to="body">
            <SongMenu v-if="menu" :items="menuItems" :x="menu.x" :y="menu.y" title="Segment" @close="menu = null" />
        </Teleport>
    </div>
</template>
