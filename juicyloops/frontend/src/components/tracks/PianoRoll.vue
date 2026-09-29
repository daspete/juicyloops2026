<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue';
import FloatingWindow from '../ui/FloatingWindow.vue';
import { centredWindow, isOnTop, nextZ, type FloatingWindowState } from '../ui/floatingWindow';
import type { TrackPlayhead } from '@/composables/useContainerView';
import { GRIDS, gridUnit, quantizeNotes, snap, type GridId, type QuantizeOptions } from '@/juicyloops/notes/grid';
import { MIN_NOTE_LENGTH, type NoteInput, type PatternNote } from '@/juicyloops/notes/Note';
import type { NotePattern } from '@/juicyloops/notes/NotePattern';
import RollLiveKeys from './roll/RollLiveKeys.vue';
import RollNoteLayer from './roll/RollNoteLayer.vue';
import RollQuantize from './roll/RollQuantize.vue';
import { clampRowShift, clampShift, copyToClipboard, editUnit, loadSnap, readClipboard, saveSnap, spanOf, type NoteOrigin } from './roll/rollEdit';
import { useRollBeam } from './roll/useRollBeam';
import { BEAT_SIZE, beatNumber, STEPS_PER_BAR } from './steps';
import VelocityLane from './velocity/VelocityLane.vue';
import VelocityTools from './velocity/VelocityTools.vue';
import { useVelocityHeight } from './velocity/useVelocityTool';

/** One row of the roll: the note a note placed on it gets, and what its key says. */
export interface RollRow {
    note: string;
    label: string;
    /** Drawn as a black key. */
    black?: boolean;
    /** A landmark row (every C, the root of a sample), drawn with a stronger key. */
    marked?: boolean;
}

/**
 * The piano roll window, floating over the whole screen like the container windows float over the song: move it by
 * its title bar, resize it by its edges, keep playing and editing the tracks while it is open.
 *
 * Notes sit anywhere in time: each is a bar from its start for its length (fractional steps), on the row of its
 * pitch. Edits snap to the grid chosen in the header (Alt/Option while dragging places freely); Quantize pulls notes
 * onto a grid afterwards. Every edit goes through the pattern's note methods, so the history records it; a drag is one
 * undo step because the history commits when the pointer comes up.
 *
 * Performance: the note bars and velocity stems are memoized per note (`v-memo`), and their geometry lives in CSS
 * variables, so zooming, resizing the window or the playhead moving re-renders none of them. Keys played live on MIDI
 * light up through `RollLiveKeys`, which alone re-renders when a key goes down or up.
 */
const props = defineProps<{
    /** The track whose notes the roll edits. */
    pattern: NotePattern;
    /** Identifies the roll (the track id): the snap setting is remembered per roll, and the keys MIDI plays on the track light up. */
    rollId: string;
    rows: readonly RollRow[];
    /**
     * The playhead; its `currentTick` is inside the pattern, -1 while stopped. Read only inside the open window, so
     * a closed roll does not re-render every step.
     */
    playhead: TrackPlayhead;
    header: string;
    accent: string;
    /** Which row a note shows on; its pitch unless the track maps notes onto fewer rows. */
    rowOf?: (note: string) => string;
    /** The row to show when the pattern is empty. */
    home?: string;
    hint?: string;
}>();

const visible = defineModel<boolean>('visible', { required: true });

defineSlots<{
    /** Extra buttons in the footer, before the hint. */
    foot?: () => unknown;
}>();

/* ---- the window ---- */

const DEFAULT_WIDTH = 1150;
const DEFAULT_HEIGHT = 680;

/** The screen, which the window floats over. */
const viewport = reactive({ width: window.innerWidth, height: window.innerHeight });
const onResize = () => {
    viewport.width = window.innerWidth;
    viewport.height = window.innerHeight;
};

/** Made the first time the roll opens, then kept, so it opens again where it was left. */
const frame = ref<FloatingWindowState | null>(null);

const bringToFront = () => {
    if (frame.value && !isOnTop(frame.value)) {
        frame.value.z = nextZ();
    }
};

const isMaximized = computed(() => frame.value?.isMaximized ?? false);

/* ---- geometry ---- */

/** A finger needs bigger targets than a mouse. */
const isCoarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

/** Width of the key column, px. */
const KEYS_WIDTH = 64;
/** The narrowest a step gets before the roll scrolls sideways instead, px. */
const MIN_STEP_WIDTH = isCoarse ? 28 : 12;
const MAX_ZOOM = 16;

/** Height of the velocity lane, px: resizable by its top edge, remembered across rolls and visits. */
const laneHeight = useVelocityHeight('roll', isCoarse ? 64 : 72);
const velocityLane = useTemplateRef<InstanceType<typeof VelocityLane>>('velocityLane');

/** Size of the scrolling area, measured: one pattern fills its width at zoom 1, and a few rows share its height. */
const areaWidth = ref(0);
const areaHeight = ref(0);

/** Height of the ruler, px (1.5rem in the CSS). */
const RULER_HEIGHT = 24;
const MAX_ROW_HEIGHT = 56;

/** Row height: finger-sized on touch screens, and taller when there are only a few rows (slices) to fill the window. */
const rowHeight = computed(() => {
    const base = isCoarse ? 34 : isMaximized.value ? 26 : 22;
    const share = Math.floor((areaHeight.value - RULER_HEIGHT - laneHeight.value - 2) / props.rows.length);
    return Math.max(base, Math.min(MAX_ROW_HEIGHT, share || 0));
});
const zoom = ref(1);

/** Pixels per step. */
const stepWidth = computed(() => {
    const fit = (areaWidth.value - KEYS_WIDTH) / props.pattern.length;
    return Math.max(MIN_STEP_WIDTH, fit || 0) * zoom.value;
});

const grid = ref<GridId>(loadSnap(props.rollId));
watch(grid, (value) => saveSnap(props.rollId, value));

const unit = computed(() => gridUnit(grid.value));

/** The spacing of the fine grid lines: the snap unit, coarsened while its lines would crowd closer than a few pixels. */
const lineUnit = computed(() => {
    let spacing = unit.value ?? 1;
    while (spacing * stepWidth.value < 6 && spacing < BEAT_SIZE) {
        spacing *= 2;
    }
    return spacing;
});

const rootStyle = computed(() => ({
    '--jl-accent': props.accent,
    '--roll-step': `${stepWidth.value}px`,
    '--roll-row': `${rowHeight.value}px`,
    '--roll-rows': props.rows.length,
    '--roll-len': props.pattern.length,
    '--roll-keys': `${KEYS_WIDTH}px`,
    '--roll-unit': lineUnit.value,
    '--roll-lane': `${laneHeight.value}px`,
}));

/** Bar and beat labels along the ruler. */
const rulerMarks = computed(() =>
    Array.from({ length: Math.ceil(props.pattern.length / BEAT_SIZE) }, (_, beat) => ({
        beat,
        bar: beat % (STEPS_PER_BAR / BEAT_SIZE) === 0,
        label: beat % (STEPS_PER_BAR / BEAT_SIZE) === 0 ? String(beat / (STEPS_PER_BAR / BEAT_SIZE) + 1) : String(beatNumber(beat)),
    })),
);

/* ---- rows ---- */

const rowIndex = computed(() => new Map(props.rows.map((row, index) => [row.note, index])));

const rowKey = (note: string): string => (props.rowOf ? props.rowOf(note) : note);

/** The row a note sits on, -1 when the roll has no row for it. */
const rowFor = (note: PatternNote): number => rowIndex.value.get(rowKey(note.note)) ?? -1;

const isShown = (note: PatternNote): boolean => rowFor(note) >= 0;

/** The row a note name (a key played live) lights, -1 when there is none. */
const rowAtName = (note: string): number => rowIndex.value.get(rowKey(note)) ?? -1;

/* ---- selection ---- */

const selected = shallowRef<ReadonlySet<string>>(new Set());

const select = (ids: Iterable<string>) => {
    selected.value = new Set(ids);
};

/** The selected notes that still exist (an undo may have taken some away), in start order. */
const selectedNotes = computed(() => (selected.value.size ? props.pattern.notes.filter((note) => selected.value.has(note.id)) : []));

const hasSelection = computed(() => selectedNotes.value.length > 0);

/** What the edit commands act on: the selection, or nothing. */
const originsOf = (notes: readonly PatternNote[]): NoteOrigin[] =>
    notes.flatMap((note) => {
        const row = rowFor(note);
        return row < 0 ? [] : [{ id: note.id, note: note.note, start: note.start, length: note.length, velocity: note.velocity, row }];
    });

/* ---- elements ---- */

const root = useTemplateRef<HTMLElement>('root');
const area = useTemplateRef<HTMLElement>('area');
const body = useTemplateRef<HTMLElement>('body');
const beam = useTemplateRef<HTMLElement>('beam');
const marker = useTemplateRef<HTMLElement>('marker');

let observer: ResizeObserver | null = null;

watch(area, (element, _, onCleanup) => {
    if (!element) {
        return;
    }
    const measure = () => {
        areaWidth.value = element.clientWidth;
        areaHeight.value = element.clientHeight;
    };
    measure();
    observer = new ResizeObserver(measure);
    observer.observe(element);
    onCleanup(() => observer?.disconnect());
});

const beamControl = useRollBeam({
    open: () => visible.value,
    playhead: props.playhead,
    stepWidth: () => stepWidth.value,
    length: () => props.pattern.length,
    beams: [beam, marker],
});

watch(stepWidth, () => beamControl.paint(), { flush: 'post' });

/** Where a point of the screen is on the roll: a (fractional) step and a (fractional) row. */
const pointAt = (clientX: number, clientY: number): { step: number; row: number } => {
    const rect = body.value!.getBoundingClientRect();
    return { step: (clientX - rect.left) / stepWidth.value, row: (clientY - rect.top) / rowHeight.value };
};

const focusRoll = () => root.value?.focus({ preventScroll: true });

/* ---- pointer gestures on the notes ---- */

/** Snapping is off with the grid off, or while Alt/Option is held. */
const isFree = (event: { altKey: boolean }) => event.altKey || unit.value === null;

/** The length a click gives a new note: the last one set, else one grid unit. */
const lastLength = ref<number | null>(null);

/** Dragging notes: moving them, or one of their ends. `anchor` is the note grabbed; `last` skips repeated edits. */
type NoteGesture = { kind: 'move' | 'start' | 'end'; pointerId: number; x: number; y: number; anchor: NoteOrigin; origins: NoteOrigin[]; moved: boolean; last: string };
type BandGesture = { kind: 'band'; pointerId: number; x: number; y: number; base: ReadonlySet<string> };
type Gesture = { kind: 'pending'; pointerId: number; x: number; y: number; touch: boolean; additive: boolean } | BandGesture | NoteGesture;

let gesture: Gesture | null = null;

/** The rubber band, in px inside the notes area. */
const band = ref<{ left: number; top: number; width: number; height: number } | null>(null);

/** How far a pointer must travel before a press becomes a drag, px. */
const dragThreshold = (touch: boolean) => (touch ? 8 : 3);

/** In select mode a press on empty space never adds a note: it selects (a drag) or clears the selection (a tap). */
const isSelectMode = ref(false);

const onBodyDown = (event: PointerEvent) => {
    if (event.button !== 0 || gesture) {
        return;
    }
    focusRoll();
    const target = event.target as HTMLElement;
    const element = target.closest<HTMLElement>('[data-id]');
    const touch = event.pointerType === 'touch';
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;

    if (!element) {
        // Empty space: a click adds a note, a drag draws a rubber band. A finger drags the roll around instead,
        // unless select mode is on.
        if (!touch || isSelectMode.value) {
            event.preventDefault();
        }
        gesture = { kind: 'pending', pointerId: event.pointerId, x: event.clientX, y: event.clientY, touch, additive };
        listen();
        return;
    }

    event.preventDefault();
    const id = element.dataset.id!;
    if (additive) {
        const next = new Set(selected.value);
        if (next.has(id)) {
            next.delete(id);
            select(next);
            return;
        }
        next.add(id);
        select(next);
    } else if (!selected.value.has(id)) {
        select([id]);
    }

    const note = props.pattern.getNote(id);
    const origins = originsOf(selectedNotes.value);
    const anchor = origins.find((origin) => origin.id === id);
    if (!note || !anchor) {
        return;
    }
    const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge;
    const kind = edge === 'start' ? 'start' : edge === 'end' ? 'end' : 'move';
    gesture = { kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, anchor, origins, moved: false, last: '' };
    listen();
};

const moveNotes = (g: NoteGesture, event: PointerEvent) => {
    const from = pointAt(g.x, g.y);
    const to = pointAt(event.clientX, event.clientY);
    const free = isFree(event);
    let target = g.anchor.start + (to.step - from.step);
    if (!free) {
        target = snap(target, grid.value);
    }
    const shift = clampShift(g.origins, target - g.anchor.start, props.pattern.length, free ? null : unit.value);
    const rows = clampRowShift(g.origins, Math.round(to.row - from.row), props.rows.length);
    const key = `${shift}|${rows}`;
    if (key === g.last) {
        return;
    }
    g.last = key;
    props.pattern.updateNotes(
        g.origins.map((origin) => ({ id: origin.id, start: origin.start + shift, note: rows === 0 ? origin.note : props.rows[origin.row + rows]!.note })),
    );
};

const resizeNotes = (g: NoteGesture, event: PointerEvent) => {
    const dx = pointAt(event.clientX, event.clientY).step - pointAt(g.x, g.y).step;
    const free = isFree(event);
    const minimum = (origin: NoteOrigin) => (free ? MIN_NOTE_LENGTH : Math.min(unit.value!, origin.length));
    const length = props.pattern.length;
    const anchor = g.anchor;
    let changes: { id: string; start?: number; length: number }[];

    if (g.kind === 'end') {
        const anchorEnd = anchor.start + anchor.length;
        const end = free ? anchorEnd + dx : snap(anchorEnd + dx, grid.value);
        const delta = end - anchorEnd;
        changes = g.origins.map((origin) => ({ id: origin.id, length: Math.min(length, Math.max(minimum(origin), origin.length + delta)) }));
    } else {
        const start = free ? anchor.start + dx : snap(anchor.start + dx, grid.value);
        const delta = start - anchor.start;
        changes = g.origins.map((origin) => {
            const end = origin.start + origin.length;
            const next = Math.min(length - MIN_NOTE_LENGTH, Math.max(0, Math.min(origin.start + delta, end - minimum(origin))));
            return { id: origin.id, start: next, length: end - next };
        });
    }

    const key = changes.map((change) => `${change.start}/${change.length}`).join('|');
    if (key === g.last) {
        return;
    }
    g.last = key;
    props.pattern.updateNotes(changes);
    const own = changes.find((change) => change.id === anchor.id);
    if (own) {
        lastLength.value = own.length;
    }
};

const updateBand = (g: BandGesture, event: PointerEvent) => {
    const from = pointAt(g.x, g.y);
    const to = pointAt(event.clientX, event.clientY);
    const step = stepWidth.value;
    const row = rowHeight.value;
    const left = Math.min(from.step, to.step);
    const right = Math.max(from.step, to.step);
    const top = Math.min(from.row, to.row);
    const bottom = Math.max(from.row, to.row);
    band.value = { left: left * step, top: top * row, width: (right - left) * step, height: (bottom - top) * row };

    const hits = new Set(g.base);
    for (const note of props.pattern.notes) {
        const noteRow = rowFor(note);
        if (noteRow >= 0 && note.start < right && note.start + note.length > left && noteRow < bottom && noteRow + 1 > top) {
            hits.add(note.id);
        }
    }
    if (hits.size !== selected.value.size || [...hits].some((id) => !selected.value.has(id))) {
        select(hits);
    }
};

/** Scrolls the roll while a drag nears its edges, so notes can be dragged (and bands drawn) past what is in view. */
const autoScroll = (event: PointerEvent) => {
    const element = area.value;
    if (!element) {
        return;
    }
    const rect = element.getBoundingClientRect();
    const EDGE = 28;
    const SPEED = 14;
    if (event.clientX > rect.right - EDGE) {
        element.scrollLeft += SPEED;
    } else if (event.clientX < rect.left + KEYS_WIDTH + EDGE) {
        element.scrollLeft -= SPEED;
    }
    if (event.clientY > rect.bottom - EDGE - laneHeight.value) {
        element.scrollTop += SPEED;
    } else if (event.clientY < rect.top + EDGE + 24) {
        element.scrollTop -= SPEED;
    }
};

const onPointerMove = (event: PointerEvent) => {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) {
        return;
    }
    if (g.kind === 'pending') {
        if (Math.hypot(event.clientX - g.x, event.clientY - g.y) < dragThreshold(g.touch)) {
            return;
        }
        gesture = { kind: 'band', pointerId: g.pointerId, x: g.x, y: g.y, base: g.additive ? selected.value : new Set() };
        onPointerMove(event);
        return;
    }
    autoScroll(event);
    if (g.kind === 'band') {
        updateBand(g, event);
        return;
    }
    if (!g.moved && Math.hypot(event.clientX - g.x, event.clientY - g.y) < dragThreshold(event.pointerType === 'touch')) {
        return;
    }
    g.moved = true;
    if (g.kind === 'move') {
        moveNotes(g, event);
    } else {
        resizeNotes(g, event);
    }
};

/** A click on empty space: a note at the (snapped) spot, as long as the last one set, and only it selected. */
const addNoteAt = (clientX: number, clientY: number, free: boolean) => {
    const point = pointAt(clientX, clientY);
    const row = props.rows[Math.floor(point.row)];
    const length = props.pattern.length;
    if (!row || point.step < 0 || point.step >= length) {
        return;
    }
    const start = Math.min(length - MIN_NOTE_LENGTH, Math.max(0, free ? point.step : snap(point.step, grid.value, 'floor')));
    const note = props.pattern.addNote({ note: row.note, start, length: lastLength.value ?? editUnit(grid.value), velocity: props.pattern.stepVelocity });
    select([note.id]);
};

const onPointerUp = (event: PointerEvent) => {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) {
        return;
    }
    if (g.kind === 'pending') {
        if (isSelectMode.value || g.additive) {
            if (!g.additive) {
                select([]);
            }
        } else {
            addNoteAt(g.x, g.y, isFree(event));
        }
    }
    endGesture();
};

function listen() {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', endGesture);
}

function endGesture() {
    gesture = null;
    band.value = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', endGesture);
}

/** Right-click on a note removes it (with the rest of the selection when it is part of one). */
const onContextMenu = (event: MouseEvent) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
    if (!id) {
        return;
    }
    removeNotes(selected.value.has(id) ? [...selected.value] : [id]);
};

/* ---- edit commands ---- */

function removeNotes(ids: readonly string[]) {
    if (!ids.length) {
        return;
    }
    props.pattern.removeNotes(ids);
    const next = new Set(selected.value);
    ids.forEach((id) => next.delete(id));
    select(next);
}

const deleteSelection = () => removeNotes(selectedNotes.value.map((note) => note.id));

const selectAll = () => select(props.pattern.notes.map((note) => note.id));

/** Adds copies of notes shifted by `shift` steps (starts wrap around the pattern) and selects them. */
const addCopies = (notes: readonly Omit<NoteInput, 'id'>[], shift: number) => {
    const added = props.pattern.addNotes(notes.map((note) => ({ note: note.note, start: note.start + shift, length: note.length, velocity: note.velocity })));
    select(added.map((note) => note.id));
};

/** Ctrl/Cmd+D: the selection again, right after itself (a whole number of grid units later). */
const duplicateSelection = () => {
    const notes = selectedNotes.value;
    if (!notes.length) {
        return;
    }
    const span = spanOf(notes);
    const width = span.end - span.start;
    addCopies(notes, unit.value === null ? width : Math.max(unit.value, snap(width, grid.value, 'ceil')));
};

const copySelection = () => copyToClipboard(selectedNotes.value);

const cutSelection = () => {
    copySelection();
    deleteSelection();
};

/** Where a paste lands: at the playhead while playing, else after the selection, else where the copied notes ended. */
const pasteTarget = (): number | null => {
    const playing = beamControl.position();
    const at = playing >= 0 ? playing : hasSelection.value ? spanOf(selectedNotes.value).end : readClipboard()?.end;
    if (at === undefined) {
        return null;
    }
    return unit.value === null ? at : snap(at, grid.value);
};

const paste = () => {
    const clipboard = readClipboard();
    const at = pasteTarget();
    if (clipboard && at !== null) {
        addCopies(clipboard.notes, at);
    }
};

/** Arrow keys: time by a grid unit (a bar with Shift), pitch by a row (an octave with Shift). */
const nudge = (steps: number, rows: number) => {
    const origins = originsOf(selectedNotes.value);
    if (!origins.length) {
        return;
    }
    const shift = clampShift(origins, steps, props.pattern.length, Math.abs(steps));
    const rowShift = clampRowShift(origins, rows, props.rows.length);
    if (!shift && !rowShift) {
        return;
    }
    props.pattern.updateNotes(
        origins.map((origin) => ({ id: origin.id, start: origin.start + shift, note: rowShift ? props.rows[origin.row + rowShift]!.note : origin.note })),
    );
};

/* ---- quantize ---- */

const isQuantizeOpen = ref(false);
/** Starts from the grid the roll snaps to, then keeps whatever was used last. */
const quantizeOptions = ref<QuantizeOptions>({ grid: grid.value === 'off' ? '1/16' : grid.value, strength: 1, ends: false });

const toggleQuantize = () => {
    isQuantizeOpen.value = !isQuantizeOpen.value;
};

const quantizeTargets = computed(() => (hasSelection.value ? selectedNotes.value : props.pattern.notes));

/** Applies the popover's options to the selection (or every note) in one edit, so it is one undo step. */
const applyQuantize = () => {
    props.pattern.updateNotes(quantizeNotes(quantizeTargets.value, quantizeOptions.value));
    isQuantizeOpen.value = false;
    focusRoll();
};

/* ---- keyboard ---- */

const isTypingTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return !!element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable);
};

/**
 * Keys of the roll (while it has the focus): Delete/Backspace removes, Ctrl/Cmd+A selects all, +C/+X/+V copy, cut
 * and paste, +D duplicates, the arrows move the selection, Escape drops it. Handled keys stop here, so the song
 * editor behind the window does not act on them too.
 */
const onKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) {
        return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    let handled = true;

    if (event.key === 'Escape') {
        if (isQuantizeOpen.value) {
            isQuantizeOpen.value = false;
        } else if (hasSelection.value) {
            select([]);
        } else {
            handled = false;
        }
    } else if (modifier && !event.altKey && key === 'a') {
        selectAll();
    } else if (modifier && !event.altKey && key === 'c') {
        copySelection();
    } else if (modifier && !event.altKey && key === 'x') {
        cutSelection();
    } else if (modifier && !event.altKey && key === 'v') {
        paste();
    } else if (modifier && !event.altKey && key === 'd') {
        duplicateSelection();
    } else if (!modifier && (event.key === 'Delete' || event.key === 'Backspace')) {
        deleteSelection();
    } else if (!modifier && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && hasSelection.value) {
        nudge((event.shiftKey ? STEPS_PER_BAR : editUnit(grid.value)) * (event.key === 'ArrowLeft' ? -1 : 1), 0);
    } else if (!modifier && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && hasSelection.value) {
        // Rows run from high to low, so up is one row back.
        nudge(0, (event.shiftKey ? 12 : 1) * (event.key === 'ArrowUp' ? -1 : 1));
    } else {
        handled = false;
    }

    if (handled) {
        event.preventDefault();
        event.stopPropagation();
    }
};

/* ---- scrolling and zoom ---- */

/** Ctrl/Cmd+wheel zooms the time axis around the pointer. */
const onWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || !area.value || !body.value) {
        return;
    }
    event.preventDefault();
    const step = pointAt(event.clientX, event.clientY).step;
    const before = stepWidth.value;
    zoom.value = Math.min(MAX_ZOOM, Math.max(1, zoom.value * (event.deltaY < 0 ? 1.25 : 0.8)));
    const element = area.value;
    void nextTick(() => {
        element.scrollLeft += step * (stepWidth.value - before);
    });
};

const zoomBy = (factor: number) => {
    zoom.value = Math.min(MAX_ZOOM, Math.max(1, zoom.value * factor));
};

/** Scrolls the roll so the pattern's notes are in view (or the home row when nothing is set yet). */
const scrollToPattern = async () => {
    await nextTick();
    const element = area.value;
    if (!element) {
        return;
    }
    const first = props.pattern.notes.find((note) => rowFor(note) >= 0);
    const index = first ? rowFor(first) : (rowIndex.value.get(props.home ?? props.pattern.stepNote) ?? 0);
    element.scrollTop = Math.max(0, (index - 5) * rowHeight.value);
};

/** Maximizing changes the row height; bring the pattern back into view afterwards. */
watch(isMaximized, () => void scrollToPattern());

onMounted(() => window.addEventListener('blur', endGesture));
onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', endGesture);
    endGesture();
});

/* Opening: bring the window back (or make it), then show the notes. Closing drops a gesture in progress. Declared last: it runs right away. */
watch(
    visible,
    async (open) => {
        if (open) {
            window.addEventListener('resize', onResize);
            onResize();
            if (frame.value) {
                bringToFront();
            } else {
                frame.value = centredWindow(viewport, DEFAULT_WIDTH, DEFAULT_HEIGHT);
                // On a phone there is no room to float: the roll fills the screen.
                frame.value.isMaximized = viewport.width < 640;
            }
            await nextTick();
            await scrollToPattern();
        } else {
            window.removeEventListener('resize', onResize);
            endGesture();
            isQuantizeOpen.value = false;
        }
    },
    { immediate: true },
);

defineExpose({ scrollToPattern });
</script>

<template>
    <Teleport to="body">
        <FloatingWindow
            v-if="visible && frame"
            :state="frame"
            :area="viewport"
            :accent="props.accent"
            :label="props.header"
            fixed
            @focus="bringToFront"
            @close="visible = false"
        >
            <template #title>
                <span class="fwin-title">{{ props.header }}</span>
            </template>
            <div ref="root" class="proll" :style="rootStyle" tabindex="-1" @keydown="onKeyDown">
                <div class="proll-bar">
                    <label class="proll-field">
                        <Icon icon="mdi:magnet" class="w-4 h-4" />
                        <span class="sr-only">Snap</span>
                        <select v-model="grid" class="select select--tight" aria-label="Snap" v-tooltip.bottom="'Snap edits to this grid. Hold Alt to place freely.'">
                            <option v-for="option in GRIDS" :key="option.id" :value="option.id">{{ option.id === 'off' ? 'No snap' : option.label }}</option>
                        </select>
                    </label>
                    <div class="proll-quantize">
                        <button
                            type="button"
                            class="chip"
                            data-quantize-toggle
                            :data-active="isQuantizeOpen"
                            :aria-expanded="isQuantizeOpen"
                            :disabled="!props.pattern.notes.length"
                            v-tooltip.bottom="'Pull the selected notes (or all) onto a grid'"
                            @click="toggleQuantize"
                        >
                            <Icon icon="mdi:format-align-justify" class="w-4 h-4" />
                            <span>Quantize</span>
                        </button>
                        <RollQuantize
                            v-if="isQuantizeOpen"
                            v-model:options="quantizeOptions"
                            :count="quantizeTargets.length"
                            :has-selection="hasSelection"
                            @apply="applyQuantize"
                            @close="isQuantizeOpen = false"
                        />
                    </div>
                    <span class="vrule"></span>
                    <button
                        type="button"
                        class="iconbtn"
                        :data-active="isSelectMode"
                        :aria-pressed="isSelectMode"
                        aria-label="Select mode"
                        v-tooltip.bottom="'Select mode: dragging over empty space selects notes and a tap never adds one'"
                        @click="isSelectMode = !isSelectMode"
                    >
                        <Icon icon="mdi:selection-drag" class="w-5 h-5" />
                    </button>
                    <button type="button" class="iconbtn" aria-label="Select all" v-tooltip.bottom="'Select all (Ctrl+A)'" @click="selectAll">
                        <Icon icon="mdi:select-all" class="w-5 h-5" />
                    </button>
                    <button type="button" class="iconbtn" aria-label="Copy" :disabled="!hasSelection" v-tooltip.bottom="'Copy (Ctrl+C)'" @click="copySelection">
                        <Icon icon="mdi:content-copy" class="w-5 h-5" />
                    </button>
                    <button type="button" class="iconbtn" aria-label="Paste" v-tooltip.bottom="'Paste at the playhead or after the selection (Ctrl+V)'" @click="paste">
                        <Icon icon="mdi:content-paste" class="w-5 h-5" />
                    </button>
                    <button type="button" class="iconbtn" aria-label="Duplicate" :disabled="!hasSelection" v-tooltip.bottom="'Duplicate (Ctrl+D)'" @click="duplicateSelection">
                        <Icon icon="mdi:content-duplicate" class="w-5 h-5" />
                    </button>
                    <button type="button" class="iconbtn" aria-label="Delete" :disabled="!hasSelection" v-tooltip.bottom="'Delete (Del)'" @click="deleteSelection">
                        <Icon icon="mdi:trash-can-outline" class="w-5 h-5" />
                    </button>
                    <span class="vrule"></span>
                    <button type="button" class="iconbtn" aria-label="Zoom out" :disabled="zoom <= 1" v-tooltip.bottom="'Zoom out (Ctrl+wheel)'" @click="zoomBy(0.8)">
                        <Icon icon="mdi:magnify-minus-outline" class="w-5 h-5" />
                    </button>
                    <button type="button" class="iconbtn" aria-label="Zoom in" :disabled="zoom >= 16" v-tooltip.bottom="'Zoom in (Ctrl+wheel)'" @click="zoomBy(1.25)">
                        <Icon icon="mdi:magnify-plus-outline" class="w-5 h-5" />
                    </button>
                    <span class="vrule"></span>
                    <VelocityTools @menu="velocityLane?.openMenu($event)" />
                    <span v-if="hasSelection" class="proll-count">{{ selectedNotes.length }} selected</span>
                </div>

                <div ref="area" class="proll-area" @wheel="onWheel">
                    <div class="proll-sheet">
                        <div class="proll-corner" aria-hidden="true"></div>
                        <div class="proll-ruler" aria-hidden="true">
                            <span v-for="mark in rulerMarks" :key="mark.beat" class="proll-mark" :class="{ 'proll-mark--bar': mark.bar }" :style="`--b:${mark.beat}`">
                                {{ mark.label }}
                            </span>
                            <div ref="marker" class="proll-marker" hidden></div>
                        </div>

                        <div class="proll-keys">
                            <div v-memo="[props.rows]">
                                <div
                                    v-for="row in props.rows"
                                    :key="row.note"
                                    class="proll-key"
                                    :class="{ 'proll-key--black': row.black, 'proll-key--marked': row.marked }"
                                >
                                    {{ row.label }}
                                </div>
                            </div>
                            <RollLiveKeys :track-id="props.rollId" :rows="props.rows" :row-at="rowAtName" part="keys" />
                        </div>

                        <div
                            ref="body"
                            class="proll-body"
                            :class="{ 'proll-body--select': isSelectMode }"
                            @pointerdown="onBodyDown"
                            @contextmenu.prevent="onContextMenu"
                        >
                            <div v-memo="[props.rows]" class="proll-rows" aria-hidden="true">
                                <template v-for="(row, index) in props.rows" :key="row.note">
                                    <div v-if="row.black || row.marked" class="proll-row" :class="{ 'proll-row--black': row.black, 'proll-row--marked': row.marked }" :style="`--r:${index}`"></div>
                                </template>
                            </div>
                            <RollLiveKeys :track-id="props.rollId" :rows="props.rows" :row-at="rowAtName" part="rows" />
                            <div class="proll-lines" aria-hidden="true"></div>
                            <RollNoteLayer :notes="props.pattern.notes" :rows="props.rows" :row-for="rowFor" :selected="selected" />
                            <div
                                v-if="band"
                                class="proll-band"
                                :style="{ left: `${band.left}px`, top: `${band.top}px`, width: `${band.width}px`, height: `${band.height}px` }"
                            ></div>
                            <div ref="beam" class="proll-beam" hidden aria-hidden="true"></div>
                        </div>

                        <div class="proll-corner proll-corner--lane">Vel</div>
                        <div class="proll-lane">
                            <VelocityLane
                                ref="velocityLane"
                                v-model:height="laneHeight"
                                :pattern="props.pattern"
                                :step-width="stepWidth"
                                :is-shown="isShown"
                                :selected="selected"
                                resize-edge="top"
                                :min-height="40"
                                :max-height="220"
                            />
                        </div>
                    </div>
                </div>

                <div class="lane-foot">
                    <slot name="foot" />
                    <span class="lane-hint">{{ props.hint }}</span>
                </div>
            </div>
        </FloatingWindow>
    </Teleport>
</template>
