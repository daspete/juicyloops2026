<script setup lang="ts">
import type { CurveShape } from '@/juicyloops/automation';
import type { PatternNote } from '@/juicyloops/notes/Note';
import type { NotePattern } from '@/juicyloops/notes/NotePattern';
import {
    accentEvery,
    clampVelocity,
    humanize,
    rampOverTime,
    rampValue,
    randomize,
    scaleAroundAverage,
    setAll,
    shiftFrom,
    type VelocityChange,
    type VelocityPoint,
} from '@/juicyloops/notes/velocityTools';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import SongMenu, { type SongMenuItem } from '../../song/SongMenu.vue';
import { beatsOf } from '../steps';
import { useVelocityTool } from './useVelocityTool';

/**
 * The velocity lane: one stem per note, at the note's real start, its height the note's velocity. Used under the step
 * grid (its stems centred under the pads, `stepWidth` unset) and in the piano roll (`stepWidth` set, stems at the
 * note starts like the roll's note bars).
 *
 * - Grab a stem's head and drag: it moves relative to where it was (Shift: fine). A grabbed stem of a selection moves
 *   the whole selection. Double-click a head: back to 100 %.
 * - Anywhere else, the shared tool (`useVelocityTool`) draws: a freehand sweep, a straight line, or a curve that
 *   keeps a bend handle until the next gesture. Alt switches Draw to Line while held.
 * - In the step grid, empty steps show a ghost stem: the velocity a step switched on gets. Drag it to change that.
 * - With notes selected, every tool and command only reaches the selection.
 * - Keys (with the lane focused): ←/→ picks a stem, ↑/↓ changes it by 1 % (Shift: 10 %), Escape drops a curve.
 * - Right-click (or `openMenu`) has the commands: humanize, randomize, scale, ramps, accents, set all, reset.
 *
 * Every gesture edits through `updateNotes` in batches, so it is one undo step (the history commits on pointer up).
 */
const props = defineProps<{
    pattern: NotePattern;
    /** Pixels per step, for a lane with a linear time axis (the piano roll). Unset: the lane lines up with step pads. */
    stepWidth?: number;
    /** Which notes have a stem; every note when unset. */
    isShown?: (note: PatternNote) => boolean;
    selected?: ReadonlySet<string>;
    /** Which edge the resize grip sits on: the bottom under the step grid, the top in the roll. */
    resizeEdge?: 'top' | 'bottom';
    minHeight?: number;
    maxHeight?: number;
    /** Title of the command menu. */
    title?: string;
}>();

const height = defineModel<number>('height', { required: true });

const { tool } = useVelocityTool();

/* ---- geometry ---- */

/** Room above the tallest stem for its head, and below the shortest, px. */
const PAD_TOP = 9;
const PAD_BOTTOM = 4;

const isCoarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
/** How close to a stem head a press must land to grab it, px. */
const GRAB = isCoarse ? 16 : 9;
/** How far a sweep reaches past the pointer, px, so a stem right beside it is caught. */
const REACH = isCoarse ? 8 : 5;
/** Space between the stems of a chord, px. */
const CHORD_GAP = 5;
/** Pixels of travel that bend a straight curve all the way. */
const BEND_TRAVEL = 80;

const isRoll = computed(() => props.stepWidth !== undefined);

const root = useTemplateRef<HTMLElement>('root');
const cellsEl = useTemplateRef<HTMLElement>('cells');

/** The lane's size, px. */
const size = ref({ width: 0, height: 0 });
/** Step mode: the centre of every pad column, px from the lane's left edge. */
const centers = shallowRef<number[]>([]);

const measure = () => {
    const element = root.value;
    if (!element) {
        return;
    }
    size.value = { width: element.clientWidth, height: element.clientHeight };
    if (!isRoll.value && cellsEl.value) {
        const left = element.getBoundingClientRect().left;
        centers.value = [...cellsEl.value.querySelectorAll<HTMLElement>('[data-cell]')].map((cell) => {
            const rect = cell.getBoundingClientRect();
            return rect.left - left + rect.width / 2;
        });
    }
};

let observer: ResizeObserver | null = null;
onMounted(() => {
    measure();
    observer = new ResizeObserver(measure);
    if (root.value) {
        observer.observe(root.value);
    }
});
onBeforeUnmount(() => observer?.disconnect());
watch(
    () => props.pattern.length,
    () => void nextTick(measure),
);

const beats = computed(() => beatsOf(props.pattern.length));

/** Where a (fractional) step is along the lane, px. */
const xOf = (step: number): number => {
    if (props.stepWidth !== undefined) {
        return step * props.stepWidth;
    }
    const list = centers.value;
    if (!list.length) {
        return 0;
    }
    const index = Math.min(list.length - 1, Math.max(0, Math.floor(step)));
    const here = list[index]!;
    const pitch = list.length > 1 ? list[1]! - list[0]! : 0;
    const next = list[index + 1] ?? here + pitch;
    return here + (step - index) * (next - here);
};

const usableHeight = computed(() => Math.max(1, size.value.height - PAD_TOP - PAD_BOTTOM));
const yOf = (value: number): number => PAD_TOP + (1 - value) * usableHeight.value;
const valueAtY = (y: number): number => clampVelocity(1 - (y - PAD_TOP) / usableHeight.value);

/* ---- stems ---- */

interface Stem {
    note: PatternNote;
    /** Where the note starts, px: what the line tools measure. */
    at: number;
    /** Where its stem is drawn, px: a chord's stems stand side by side around `at`. */
    x: number;
}

const shownNotes = computed(() => (props.isShown ? props.pattern.notes.filter(props.isShown) : props.pattern.notes));

const stems = computed<Stem[]>(() => {
    const notes = shownNotes.value;
    const result: Stem[] = [];
    for (let i = 0; i < notes.length; ) {
        let j = i + 1;
        while (j < notes.length && Math.abs(notes[j]!.start - notes[i]!.start) < 1e-6) {
            j++;
        }
        const at = xOf(notes[i]!.start);
        const count = j - i;
        for (let k = i; k < j; k++) {
            result.push({ note: notes[k]!, at, x: at + (k - i - (count - 1) / 2) * CHORD_GAP });
        }
        i = j;
    }
    return result;
});

const hasSelection = computed(() => !!props.selected?.size && shownNotes.value.some((note) => props.selected!.has(note.id)));

/** What tools and commands reach: the selection, or every stem. */
const pool = computed(() => (hasSelection.value ? stems.value.filter((stem) => props.selected!.has(stem.note.id)) : stems.value));

/** Step mode: the empty steps, whose ghost stem shows the velocity a new step gets. */
const ghosts = computed(() => {
    if (isRoll.value || !centers.value.length) {
        return [];
    }
    const lit = new Set(props.pattern.notes.map((note) => Math.floor(note.start + 1e-6)));
    return Array.from({ length: props.pattern.length }, (_, step) => step).filter((step) => !lit.has(step));
});

/* ---- editing ---- */

/** Sets velocities, leaving out the ones that already have them; one batch, so the history sees one edit. */
const apply = (changes: readonly VelocityChange[]) => {
    const current = new Map(props.pattern.notes.map((note) => [note.id, note.velocity]));
    const real = changes.filter((change) => current.has(change.id) && current.get(change.id) !== change.velocity);
    if (real.length) {
        props.pattern.updateNotes(real);
    }
};

const stepLabel = (start: number) => (Math.abs(start - Math.round(start)) < 1e-6 ? String(Math.round(start) + 1) : (start + 1).toFixed(2));
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The readout bubble: while dragging, and over a stem head. */
const readout = ref<{ x: number; y: number; text: string } | null>(null);

type Hit = { kind: 'note'; stem: Stem } | { kind: 'ghost'; step: number };

const local = (event: { clientX: number; clientY: number }) => {
    const rect = root.value!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

/** The stem head under a point: real notes first, the ghosts of empty steps after them. */
const headAt = (x: number, y: number): Hit | null => {
    let best: Hit | null = null;
    let bestDistance = Infinity;
    for (const stem of stems.value) {
        const dx = Math.abs(stem.x - x);
        const dy = Math.abs(yOf(stem.note.velocity) - y);
        if (dx <= GRAB && dy <= GRAB + 2 && dx + dy < bestDistance) {
            best = { kind: 'note', stem };
            bestDistance = dx + dy;
        }
    }
    if (best) {
        return best;
    }
    for (const step of ghosts.value) {
        const dx = Math.abs(xOf(step) - x);
        const dy = Math.abs(yOf(props.pattern.stepVelocity) - y);
        if (dx <= GRAB && dy <= GRAB + 2 && dx + dy < bestDistance) {
            best = { kind: 'ghost', step };
            bestDistance = dx + dy;
        }
    }
    return best;
};

/* ---- the ramp of the line and curve tools ---- */

interface Ramp {
    a: VelocityPoint;
    b: VelocityPoint;
    shape: CurveShape;
    tension: number;
    /** The notes the ramp may reach, with where they are and what they had when it began. */
    origins: { id: string; at: number; velocity: number }[];
    /** Kept after the drag, with a bend handle (curve tool). */
    isCurve: boolean;
}

const ramp = ref<Ramp | null>(null);

const rampChanges = (r: Ramp): VelocityChange[] => {
    const low = Math.min(r.a.at, r.b.at) - REACH;
    const high = Math.max(r.a.at, r.b.at) + REACH;
    return r.origins.map((origin) => ({
        id: origin.id,
        velocity: origin.at >= low && origin.at <= high ? clampVelocity(rampValue(r.a, r.b, origin.at, r.shape, r.tension)) : origin.velocity,
    }));
};

/** An S-curve passes the middle at half height whatever its bend, so its handle sits a quarter of the way in. */
const handle = computed(() => {
    const r = ramp.value;
    if (!r || !r.isCurve) {
        return null;
    }
    const t = r.shape === 's-curve' ? 0.25 : 0.5;
    const [from, to] = r.a.at <= r.b.at ? [r.a, r.b] : [r.b, r.a];
    const at = from.at + (to.at - from.at) * t;
    return { x: at, y: yOf(rampValue(r.a, r.b, at, r.shape, r.tension)) };
});

const rampPath = computed(() => {
    const r = ramp.value;
    if (!r) {
        return '';
    }
    const SAMPLES = 32;
    const points: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
        const at = r.a.at + ((r.b.at - r.a.at) * i) / SAMPLES;
        points.push(`${at.toFixed(1)},${yOf(rampValue(r.a, r.b, at, r.shape, r.tension)).toFixed(1)}`);
    }
    return points.join(' ');
});

const dropRamp = () => (ramp.value = null);
watch(tool, dropRamp);

/* ---- pointer gestures ---- */

type Gesture =
    | { kind: 'shift'; startY: number; origins: VelocityChange[]; anchor: Stem }
    | { kind: 'ghost'; startY: number; origin: number; step: number }
    | { kind: 'draw'; last: VelocityPoint }
    | { kind: 'ramp'; isCurve: boolean }
    | { kind: 'bend'; startY: number; tension: number; direction: number }
    | { kind: 'resize'; startY: number; height: number };

let gesture: Gesture | null = null;
const isDragging = ref(false);

const focusedId = ref<string | null>(null);

const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !root.value) {
        return;
    }
    event.preventDefault();
    root.value.focus({ preventScroll: true });
    const { x, y } = local(event);

    if (handle.value && Math.hypot(handle.value.x - x, handle.value.y - y) <= GRAB + 2) {
        const r = ramp.value!;
        // Positive tension lowers the handle of a rising ramp and lifts the handle of a falling one (drawn left to right).
        const rising = (r.a.at <= r.b.at ? r.b.value - r.a.value : r.a.value - r.b.value) >= 0;
        gesture = { kind: 'bend', startY: event.clientY, tension: r.tension, direction: rising ? -1 : 1 };
    } else {
        const hit = headAt(x, y);
        dropRamp();
        const effective = event.altKey && tool.value === 'draw' ? 'line' : tool.value;
        if (hit?.kind === 'note') {
            const id = hit.stem.note.id;
            focusedId.value = id;
            const targets = hasSelection.value && props.selected!.has(id) ? pool.value : [hit.stem];
            gesture = { kind: 'shift', startY: event.clientY, origins: targets.map((stem) => ({ id: stem.note.id, velocity: stem.note.velocity })), anchor: hit.stem };
            readout.value = { x: hit.stem.x, y: yOf(hit.stem.note.velocity), text: `Step ${stepLabel(hit.stem.note.start)} · ${percent(hit.stem.note.velocity)}` };
        } else if (hit?.kind === 'ghost') {
            gesture = { kind: 'ghost', startY: event.clientY, origin: props.pattern.stepVelocity, step: hit.step };
            readout.value = { x: xOf(hit.step), y: yOf(props.pattern.stepVelocity), text: `New steps · ${percent(props.pattern.stepVelocity)}` };
        } else if (effective === 'draw') {
            const point = { at: x, value: valueAtY(y) };
            gesture = { kind: 'draw', last: point };
            drawTo(point);
        } else {
            const point = { at: x, value: valueAtY(y) };
            ramp.value = {
                a: point,
                b: point,
                shape: 'curve',
                tension: 0,
                origins: pool.value.map((stem) => ({ id: stem.note.id, at: stem.at, velocity: stem.note.velocity })),
                isCurve: false,
            };
            gesture = { kind: 'ramp', isCurve: effective === 'curve' };
            apply(rampChanges(ramp.value));
            readout.value = { x, y, text: percent(point.value) };
        }
    }
    isDragging.value = true;
    root.value.setPointerCapture(event.pointerId);
};

/** Draw tool: every stem between the last point and this one takes the value of the line between them. */
const drawTo = (point: VelocityPoint) => {
    const g = gesture;
    if (g?.kind !== 'draw') {
        return;
    }
    const low = Math.min(g.last.at, point.at) - REACH;
    const high = Math.max(g.last.at, point.at) + REACH;
    apply(
        pool.value
            .filter((stem) => stem.at >= low && stem.at <= high)
            .map((stem) => ({ id: stem.note.id, velocity: clampVelocity(rampValue(g.last, point, stem.at)) })),
    );
    g.last = point;
    readout.value = { x: point.at, y: yOf(point.value), text: percent(point.value) };
};

const onPointerMove = (event: PointerEvent) => {
    const { x, y } = local(event);
    const g = gesture;
    if (!g) {
        hover(x, y);
        return;
    }
    const scale = event.shiftKey ? 0.25 : 1;
    if (g.kind === 'shift') {
        const delta = ((g.startY - event.clientY) / usableHeight.value) * scale;
        apply(shiftFrom(g.origins, delta));
        const velocity = props.pattern.getNote(g.anchor.note.id)?.velocity ?? 0;
        readout.value = { x: g.anchor.x, y: yOf(velocity), text: `Step ${stepLabel(g.anchor.note.start)} · ${percent(velocity)}` };
    } else if (g.kind === 'ghost') {
        const value = clampVelocity(g.origin + ((g.startY - event.clientY) / usableHeight.value) * scale);
        props.pattern.setStepVelocity(value);
        readout.value = { x: xOf(g.step), y: yOf(value), text: `New steps · ${percent(value)}` };
    } else if (g.kind === 'draw') {
        drawTo({ at: x, value: valueAtY(y) });
    } else if (g.kind === 'ramp' && ramp.value) {
        ramp.value = { ...ramp.value, b: { at: x, value: valueAtY(y) } };
        apply(rampChanges(ramp.value));
        readout.value = { x, y: yOf(ramp.value.b.value), text: `${percent(ramp.value.a.value)} → ${percent(ramp.value.b.value)}` };
    } else if (g.kind === 'bend' && ramp.value) {
        const up = (g.startY - event.clientY) / BEND_TRAVEL;
        const tension = Math.round(Math.max(-1, Math.min(1, g.tension + g.direction * up)) * 100) / 100;
        ramp.value = { ...ramp.value, tension };
        apply(rampChanges(ramp.value));
        readout.value = handle.value ? { ...handle.value, text: rampTag(ramp.value) } : null;
    } else if (g.kind === 'resize') {
        const dy = event.clientY - g.startY;
        height.value = Math.round(Math.min(props.maxHeight ?? 240, Math.max(props.minHeight ?? 40, g.height + (props.resizeEdge === 'top' ? -dy : dy))));
    }
};

const rampTag = (r: Ramp) => `${r.shape === 's-curve' ? 'S-curve' : 'Curve'} ${Math.round(r.tension * 100)}%`;

const endGesture = (event?: PointerEvent) => {
    const g = gesture;
    gesture = null;
    isDragging.value = false;
    readout.value = null;
    if (event && root.value?.hasPointerCapture(event.pointerId)) {
        root.value.releasePointerCapture(event.pointerId);
    }
    if (g?.kind === 'ramp' && ramp.value) {
        // A curve stays with its bend handle when it has some length; a line is done.
        ramp.value = g.isCurve && Math.abs(ramp.value.b.at - ramp.value.a.at) > 6 ? { ...ramp.value, isCurve: true } : null;
    }
};

const hover = (x: number, y: number) => {
    const hit = headAt(x, y);
    if (hit?.kind === 'note') {
        readout.value = { x: hit.stem.x, y: yOf(hit.stem.note.velocity), text: `Step ${stepLabel(hit.stem.note.start)} · ${percent(hit.stem.note.velocity)}` };
    } else if (hit?.kind === 'ghost') {
        readout.value = { x: xOf(hit.step), y: yOf(props.pattern.stepVelocity), text: `New steps · ${percent(props.pattern.stepVelocity)}` };
    } else {
        readout.value = null;
    }
};

const onPointerLeave = () => {
    if (!gesture) {
        readout.value = null;
    }
};

const onDoubleClick = (event: MouseEvent) => {
    const { x, y } = local(event);
    if (handle.value && ramp.value && Math.hypot(handle.value.x - x, handle.value.y - y) <= GRAB + 2) {
        ramp.value = { ...ramp.value, tension: 0 };
        apply(rampChanges(ramp.value));
        return;
    }
    const hit = headAt(x, y);
    if (hit?.kind === 'note') {
        apply([{ id: hit.stem.note.id, velocity: 1 }]);
    } else if (hit?.kind === 'ghost') {
        props.pattern.setStepVelocity(1);
    }
};

const onResizeDown = (event: PointerEvent) => {
    if (event.button !== 0 || !root.value) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    dropRamp();
    gesture = { kind: 'resize', startY: event.clientY, height: height.value };
    isDragging.value = true;
    root.value.setPointerCapture(event.pointerId);
};

/* ---- keyboard ---- */

const onKeyDown = (event: KeyboardEvent) => {
    let handled = true;
    const order = stems.value;
    const index = order.findIndex((stem) => stem.note.id === focusedId.value);

    if (event.key === 'Escape' && ramp.value) {
        dropRamp();
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.ctrlKey && !event.metaKey && order.length) {
        const next = index < 0 ? 0 : Math.min(order.length - 1, Math.max(0, index + (event.key === 'ArrowLeft' ? -1 : 1)));
        focusedId.value = order[next]!.note.id;
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.metaKey && order.length) {
        const stem = order[index] ?? order[0]!;
        focusedId.value = stem.note.id;
        const delta = (event.shiftKey ? 0.1 : 0.01) * (event.key === 'ArrowUp' ? 1 : -1);
        const targets = hasSelection.value && props.selected!.has(stem.note.id) ? pool.value : [stem];
        apply(shiftFrom(targets.map((target) => ({ id: target.note.id, velocity: target.note.velocity })), delta));
    } else {
        handled = false;
    }
    if (handled) {
        event.preventDefault();
        event.stopPropagation();
    }
};

const onFocusOut = (event: FocusEvent) => {
    // The command menu takes the focus while open; the curve must survive that, its shape is picked there.
    if (!menu.value && !root.value?.contains(event.relatedTarget as Node | null)) {
        focusedId.value = null;
        dropRamp();
    }
};

/* ---- the command menu ---- */

const menu = ref<{ x: number; y: number } | null>(null);

const openMenu = (event: MouseEvent) => {
    if (event.type === 'click') {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        menu.value = { x: rect.left, y: rect.bottom + 4 };
    } else {
        menu.value = { x: event.clientX, y: event.clientY };
    }
};

/** Switches the curve between curve and S-curve (keeping its bend), or sets its bend. */
const reshape = (shape: CurveShape, tension = ramp.value?.tension ?? 0) => {
    if (!ramp.value) {
        return;
    }
    ramp.value = { ...ramp.value, shape, tension };
    apply(rampChanges(ramp.value));
};

const targetNotes = () => pool.value.map((stem) => stem.note);

const menuItems = computed<SongMenuItem[]>(() => {
    const none = !pool.value.length;
    const item = (label: string, icon: string, run: () => VelocityChange[]): SongMenuItem => ({ label, icon, disabled: none, action: () => apply(run()) });
    const r = ramp.value;
    const shapes: SongMenuItem[] = r?.isCurve
        ? [
              ...(['curve', 's-curve'] as const).map((shape) => ({ label: shape === 'curve' ? 'Curve' : 'S-curve', checked: r.shape === shape, action: () => reshape(shape) })),
              { label: 'Straighten', icon: 'mdi:vector-line', disabled: !r.tension, action: () => reshape(r.shape, 0) },
              {},
          ]
        : [];
    return [
        ...shapes,
        item('Humanize ±5 %', 'mdi:account-music-outline', () => humanize(targetNotes(), 0.05)),
        item('Humanize ±15 %', 'mdi:account-music', () => humanize(targetNotes(), 0.15)),
        item('Randomize 40–100 %', 'mdi:dice-5-outline', () => randomize(targetNotes(), 0.4, 1)),
        {},
        item('More dynamic', 'mdi:arrow-expand-vertical', () => scaleAroundAverage(targetNotes(), 1.5)),
        item('Less dynamic', 'mdi:arrow-collapse-vertical', () => scaleAroundAverage(targetNotes(), 0.5)),
        {},
        item('Ramp up', 'mdi:trending-up', () => rampOverTime(targetNotes(), 0.3, 1)),
        item('Ramp down', 'mdi:trending-down', () => rampOverTime(targetNotes(), 1, 0.3)),
        item('Accent every beat', 'mdi:music-accidental-sharp', () => accentEvery(targetNotes(), 4)),
        item('Accent every 2nd step', 'mdi:music-accidental-sharp', () => accentEvery(targetNotes(), 2)),
        {},
        item('Set all to 25 %', 'mdi:signal-cellular-1', () => setAll(targetNotes(), 0.25)),
        item('Set all to 50 %', 'mdi:signal-cellular-2', () => setAll(targetNotes(), 0.5)),
        item('Set all to 75 %', 'mdi:signal-cellular-3', () => setAll(targetNotes(), 0.75)),
        item('Reset to 100 %', 'mdi:restore', () => setAll(targetNotes(), 1)),
    ];
});

const menuTitle = computed(() => {
    const count = pool.value.length;
    const scope = hasSelection.value ? `${count} selected` : `${count} note${count === 1 ? '' : 's'}`;
    return props.title ? `${props.title} · ${scope}` : `Velocity · ${scope}`;
});

defineExpose({ openMenu });

const GUIDES = [1, 0.75, 0.5, 0.25] as const;
</script>

<template>
    <div
        ref="root"
        class="velo"
        :class="{ 'velo--roll': isRoll, 'velo--steps': !isRoll, 'velo--dragging': isDragging, 'velo--selection': hasSelection }"
        :style="isRoll ? undefined : { height: `${height}px` }"
        role="group"
        aria-label="Velocity lane"
        tabindex="0"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="endGesture"
        @pointercancel="endGesture"
        @lostpointercapture="gesture && endGesture()"
        @pointerleave="onPointerLeave"
        @dblclick="onDoubleClick"
        @contextmenu.prevent="openMenu"
        @keydown="onKeyDown"
        @focusout="onFocusOut"
    >
        <div v-if="!isRoll" ref="cells" class="steps velo-cells" aria-hidden="true">
            <div v-for="(beat, beatIndex) in beats" :key="beatIndex" class="beat">
                <div v-for="index in beat" :key="index" class="velo-cell" :class="{ 'velo-cell--downbeat': index % 4 === 0 }" data-cell></div>
            </div>
        </div>

        <div class="velo-field" aria-hidden="true">
            <div v-for="guide in GUIDES" :key="guide" class="velo-guide" :style="{ top: `${(1 - guide) * 100}%` }"></div>
            <div
                v-for="step in ghosts"
                :key="`ghost-${step}`"
                class="velo-stem velo-stem--ghost"
                :style="{ '--x': `${xOf(step)}px`, '--v': props.pattern.stepVelocity }"
            ></div>
            <div
                v-for="stem in stems"
                :key="stem.note.id"
                class="velo-stem"
                :class="{
                    'velo-stem--selected': hasSelection && props.selected!.has(stem.note.id),
                    'velo-stem--dim': hasSelection && !props.selected!.has(stem.note.id),
                    'velo-stem--focused': focusedId === stem.note.id,
                }"
                :style="{ '--x': `${stem.x}px`, '--v': stem.note.velocity }"
            ></div>
        </div>

        <div v-if="!isRoll" class="velo-scale" aria-hidden="true">
            <span style="top: 0%">100</span>
            <span style="top: 50%">50</span>
            <span style="top: 100%">0</span>
        </div>

        <svg v-if="ramp" class="velo-ramp" :width="size.width" :height="size.height" aria-hidden="true">
            <polyline :points="rampPath" />
            <circle v-if="handle" class="velo-ramp-handle" :cx="handle.x" :cy="handle.y" r="6" />
        </svg>

        <div v-if="readout" class="velo-readout" :data-below="readout.y < 26" :style="{ left: `${readout.x}px`, top: `${readout.y}px` }">{{ readout.text }}</div>

        <div
            class="velo-grip"
            :class="props.resizeEdge === 'top' ? 'velo-grip--top' : 'velo-grip--bottom'"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the velocity lane"
            v-tooltip.bottom="{ value: 'Drag to resize', showDelay: 800 }"
            @pointerdown="onResizeDown"
        ></div>

        <SongMenu v-if="menu" :items="menuItems" :x="menu.x" :y="menu.y" :title="menuTitle" @close="menu = null" />
    </div>
</template>
