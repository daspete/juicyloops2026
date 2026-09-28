<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useConfirm, useToast } from 'primevue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchPostEffect } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useContainerWindows } from '@/composables/useContainerWindows';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { STEP_COUNT } from '@/juicyloops/constants';
import type { SongAutomationLane as SongAutomationLaneModel } from '@/juicyloops/automation';
import { SONG_SNAP, SONG_STEPS_PER_BAR, snapStep, type ClipSpec, type SongClip, type SongLane } from '@/juicyloops/song';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import { TRACK_META } from '../tracks/trackMeta';
import LiveText from '../ui/LiveText.vue';
import ClipPreview from './ClipPreview.vue';
import ContainerWindows from './ContainerWindows.vue';
import { containerHue as hueOf } from './containerHue';
import SongAutomationLane from './SongAutomationLane.vue';
import SongMenu, { type SongMenuItem } from './SongMenu.vue';

/**
 * The song view, a playlist like in FL Studio: the containers sit in a picker on the left, lanes run left to right
 * on a timeline measured in bars, and every clip on a lane is a container playing for a while.
 *
 * Tools (with their FL Studio keys): Draw (P) places the brush clip with a click and moves or resizes clips,
 * Paint (B) lays the brush down again and again, Delete (D) sweeps clips away, Mute (T) silences clips,
 * Slice (C) cuts them and Select (E) draws a selection box. Right-click deletes with the drawing tools,
 * Ctrl+drag selects with any tool, starting on a clip or on empty space (Ctrl+click toggles one clip), Shift+drag clones, Alt ignores the grid.
 *
 * The ruler sets the song position marker (click) or the loop region (drag). Ctrl+wheel zooms, Alt+wheel
 * changes the lane height. Automation lanes below the clips draw a value over the same timeline.
 *
 * Containers are edited right here, in floating windows over the timeline (double-click a container or a clip),
 * so tracks can be changed while the song plays.
 */
const { bpm, containers, currentContainer, song, currentStep, isPlaying, songLoop, cueSong, selectContainer, duplicateContainer, addContainer, resolveTarget } = useJuicyLoops();
const confirm = useConfirm();
const toast = useToast();
const router = useRouter();

const hasTracks = computed(() => containers.value.some((container) => container.tracks.length > 0));

/* ---- editor settings, remembered per browser ---- */

const SETTINGS_KEY = 'juicyloops:song-editor';

interface Settings {
    stepPx: number;
    laneHeight: number;
    grid: number;
    follow: boolean;
    picker: boolean;
}

const readSettings = (): Partial<Settings> => {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    } catch {
        return {};
    }
};

const stored = readSettings();

const MIN_STEP_PX = 2;
const MAX_STEP_PX = 48;
const LANE_HEIGHTS = [34, 46, 64, 88, 120];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Pixels per step: the horizontal zoom. */
const stepPx = ref(clamp(stored.stepPx ?? 12, MIN_STEP_PX, MAX_STEP_PX));
const laneHeight = ref(LANE_HEIGHTS.includes(stored.laneHeight ?? 0) ? stored.laneHeight! : 64);

const GRIDS = [
    { steps: SONG_STEPS_PER_BAR, label: 'Bar' },
    { steps: SONG_SNAP, label: 'Beat' },
    { steps: 1, label: 'Step' },
] as const;
const grid = ref<number>(GRIDS.some((option) => option.steps === stored.grid) ? stored.grid! : SONG_SNAP);
/** Keep the playhead in view while playing. */
const follow = ref(stored.follow ?? true);
const isPickerOpen = ref(stored.picker ?? true);

watch(
    [stepPx, laneHeight, grid, follow, isPickerOpen],
    () => {
        try {
            localStorage.setItem(
                SETTINGS_KEY,
                JSON.stringify({ stepPx: stepPx.value, laneHeight: laneHeight.value, grid: grid.value, follow: follow.value, picker: isPickerOpen.value }),
            );
        } catch {
            /* blocked storage: the settings simply do not persist */
        }
    },
    { flush: 'post' },
);

watch(grid, (value) => (song.value.grid = value), { immediate: true });

/* ---- timeline geometry ---- */

const scroller = ref<HTMLElement | null>(null);
const viewportWidth = ref(0);
let resizeObserver: ResizeObserver | null = null;

/** Empty bars after the last clip, so there is always room to draw the next one. */
const TAIL_BARS = 8;
const MIN_BARS = 16;

const bars = computed(() => song.value.length / SONG_STEPS_PER_BAR);
const totalBars = computed(() => {
    const visible = Math.ceil(viewportWidth.value / (stepPx.value * SONG_STEPS_PER_BAR)) + 1;
    const loopEnd = songLoop.value ? Math.ceil(songLoop.value.end / SONG_STEPS_PER_BAR) + 2 : 0;
    return Math.max(MIN_BARS, bars.value + TAIL_BARS, visible, loopEnd);
});
const totalSteps = computed(() => totalBars.value * SONG_STEPS_PER_BAR);

const timelineStyle = computed(() => ({
    '--jl-song-step': `${stepPx.value}px`,
    '--jl-song-steps': totalSteps.value,
    '--jl-lane-h': `${laneHeight.value}px`,
}));

/** Bar numbers thin out when bars get too narrow to hold one. */
const labelEvery = computed(() => {
    const barPx = stepPx.value * SONG_STEPS_PER_BAR;
    return barPx >= 30 ? 1 : barPx >= 15 ? 2 : barPx >= 7 ? 4 : 8;
});

/** Length of the song at the current tempo, as `m:ss`. */
const duration = computed(() => {
    const seconds = Math.round((bars.value * 4 * 60) / bpm.value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

/** A step as `bar.beat`, the way the ruler counts. */
const formatStep = (step: number) => `${Math.floor(step / SONG_STEPS_PER_BAR) + 1}.${Math.floor((step % SONG_STEPS_PER_BAR) / 4) + 1}`;

const spanStyle = (span: { start: number; length: number }) => ({
    left: `calc(${span.start} * var(--jl-song-step))`,
    width: `calc(${span.length} * var(--jl-song-step))`,
});

/** One hue per container, so clips of the same container look the same everywhere. */
const containerHue = (id: string) => hueOf(containers.value, id);
const containerById = (id: string) => containers.value.find((container) => container.id === id);
const containerName = (id: string) => containerById(id)?.name ?? 'Removed container';

/** A new clip is as long as the container's longest loop. */
const defaultLength = (container: TrackContainer) => Math.max(STEP_COUNT, ...container.tracks.map((track) => track.length));

/* ---- tools ---- */

type Tool = 'draw' | 'paint' | 'erase' | 'mute' | 'slice' | 'select';
const tool = ref<Tool>('draw');
const TOOLS: readonly { key: Tool; label: string; icon: string; shortcut: string; hint: string }[] = [
    { key: 'draw', label: 'Draw', icon: 'mdi:pencil', shortcut: 'P', hint: 'Click to place the brush, drag clips to move them, drag their edges to resize' },
    { key: 'paint', label: 'Paint', icon: 'mdi:brush', shortcut: 'B', hint: 'Drag along a lane to lay the brush down again and again' },
    { key: 'erase', label: 'Delete', icon: 'mdi:eraser', shortcut: 'D', hint: 'Click or sweep over clips to delete them' },
    { key: 'mute', label: 'Mute', icon: 'mdi:volume-off', shortcut: 'T', hint: 'Click or sweep over clips to mute or unmute them' },
    { key: 'slice', label: 'Slice', icon: 'mdi:content-cut', shortcut: 'C', hint: 'Click a clip to cut it in two' },
    { key: 'select', label: 'Select', icon: 'mdi:selection-drag', shortcut: 'E', hint: 'Drag a box around clips to select them' },
];

/* ---- the brush: what Draw and Paint lay down ---- */

const brush = ref<{ containerId: string; length: number } | null>(null);

/** Without a pick yet, the brush is the container the mixer shows, or else the first one that has something to play. */
watch(
    containers,
    (list) => {
        if (brush.value && list.some((container) => container.id === brush.value!.containerId)) {
            return;
        }
        const current = currentContainer.value.tracks.length ? currentContainer.value : null;
        const first = current ?? list.find((container) => container.tracks.length) ?? list[0];
        brush.value = first ? { containerId: first.id, length: defaultLength(first) } : null;
    },
    { immediate: true, deep: 1 },
);

/** Picking a brush selects its container too, so the mixer shows the channel of what was picked. */
const setBrush = (containerId: string, length: number) => {
    brush.value = { containerId, length };
    selectContainer(containerId);
};

const pickBrush = (container: TrackContainer) => {
    setBrush(container.id, defaultLength(container));
    if (tool.value !== 'draw' && tool.value !== 'paint') {
        tool.value = 'draw';
    }
};

/* ---- selection ---- */

const selection = ref<string[]>([]);
/** The selection without clips that are gone (after an undo, say). */
const selectedIds = computed(() => selection.value.filter((id) => song.value.getClip(id)));
const selectedSet = computed(() => new Set(selectedIds.value));
const isSelected = (id: string) => selectedSet.value.has(id);

const selectClips = (ids: string[]) => {
    selection.value = ids;
};

const selectAll = () => selectClips(song.value.clips.map((clip) => clip.id));

const selectionSpan = computed(() => {
    const clips = selectedIds.value.map((id) => song.value.getClip(id)!);
    if (!clips.length) {
        return null;
    }
    const start = Math.min(...clips.map((clip) => clip.start));
    return { start, end: Math.max(...clips.map((clip) => clip.start + clip.length)) };
});

/* ---- editing ---- */

const deleteClips = (ids: readonly string[]) => {
    song.value.removeClips(ids);
    selection.value = selection.value.filter((id) => !ids.includes(id));
};

const noRoom = (detail: string) => toast.add({ severity: 'warn', summary: 'No room', detail, life: 2500 });

const duplicateSelection = () => {
    const copies = song.value.duplicateClips(selectedIds.value);
    if (copies) {
        selectClips(copies.map((clip) => clip.id));
    } else if (selectedIds.value.length) {
        noRoom('The copy would land on other clips. Clear the space after the selection first.');
    }
};

const nudgeSelection = (delta: number, laneDelta: number) => {
    const ids = selectedIds.value;
    const minStart = Math.min(...ids.map((id) => song.value.getClip(id)!.start));
    song.value.moveClips(ids, Math.max(delta, -minStart), laneDelta);
};

const toggleMute = (ids: readonly string[]) => {
    const clips = ids.map((id) => song.value.getClip(id)).filter((clip): clip is SongClip => !!clip);
    const mute = clips.some((clip) => !clip.isMuted);
    clips.forEach((clip) => (clip.isMuted = mute));
};

/** The clipboard outlives the view, so clips can be copied, and pasted after a trip to the tracks. */
interface ClipboardClip {
    laneIndex: number;
    containerId: string;
    start: number;
    length: number;
    offset: number;
    isMuted?: boolean;
}
const clipboard = ref<ClipboardClip[]>([]);

const copySelection = () => {
    const span = selectionSpan.value;
    if (!span) {
        return;
    }
    clipboard.value = selectedIds.value.map((id) => {
        const clip = song.value.getClip(id)!;
        return {
            laneIndex: song.value.lanes.indexOf(song.value.laneOf(id)!),
            containerId: clip.containerId,
            start: clip.start - span.start,
            length: clip.length,
            offset: clip.offset,
            isMuted: clip.isMuted,
        };
    });
};

/** Pastes at the song position marker, on the lanes the clips came from (new lanes are added when needed). */
const paste = () => {
    if (!clipboard.value.length) {
        return;
    }
    const at = snapStep(currentStep.value, grid.value);
    while (song.value.lanes.length <= Math.max(...clipboard.value.map((item) => item.laneIndex))) {
        song.value.addLane();
    }
    const specs: ClipSpec[] = clipboard.value
        .filter((item) => containerById(item.containerId))
        .map((item) => ({
            laneId: song.value.lanes[item.laneIndex]!.id,
            containerId: item.containerId,
            start: at + item.start,
            length: item.length,
            offset: item.offset,
            isMuted: item.isMuted,
        }));
    const placed = song.value.placeClips(specs);
    if (placed) {
        selectClips(placed.map((clip) => clip.id));
    } else {
        noRoom(`Something is already there at bar ${formatStep(at)}. Move the position marker to free space.`);
    }
};

/** A clip of its own: the container is copied and the clip plays the copy, so it can change without touching the others. */
const makeUnique = async (clip: SongClip) => {
    const copy = await duplicateContainer(clip.containerId);
    const current = song.value.getClip(clip.id);
    if (copy && current) {
        current.containerId = copy.id;
    }
};

const splitAtCue = (clip: SongClip) => {
    const right = song.value.splitClip(clip.id, currentStep.value);
    if (right) {
        selectClips([right.id]);
    }
};

const windowLayer = ref<InstanceType<typeof ContainerWindows> | null>(null);
const { open: openWindow, activeId: activeWindowId } = useContainerWindows();

/** Opens the container's window over the song, where its tracks can be changed while the song plays. */
const editContainer = (containerId: string) => {
    if (windowLayer.value) {
        openWindow(containerId, windowLayer.value.area);
    }
};

/** Takes the container to the track view, which loops it on its own. */
const openInTrackView = (containerId: string) => {
    selectContainer(containerId);
    router.push({ name: 'app.index' });
};

/** A fresh container, opened in its window to fill it. */
const newContainer = () => {
    editContainer(addContainer().id);
};

/** A new automation lane starts on the master's level; the lane's own menus change what it drives. */
const addAutomation = () => song.value.addAutomation({ kind: 'master' }, 'volume');

/** Removing a lane puts the value back where its knob is. */
const removeAutomation = (lane: SongAutomationLaneModel) => {
    resolveTarget(lane.target)?.settle(lane.param);
    song.value.removeAutomation(lane.id);
};

/** Spreads the lanes over the hue wheel. */
const automationHue = (index: number) => 200 + index * 47;

/* ---- lanes ---- */

const hasSolo = computed(() => song.value.lanes.some((lane) => lane.isSolo));
const isAudible = (lane: SongLane) => (hasSolo.value ? !!lane.isSolo : !lane.isMuted);

const editingLaneId = ref<string | null>(null);
const laneDraft = ref('');
const laneInput = ref<HTMLInputElement[]>([]);

const startRenameLane = async (lane: SongLane) => {
    editingLaneId.value = lane.id;
    laneDraft.value = lane.name;
    await nextTick();
    laneInput.value[0]?.focus();
    laneInput.value[0]?.select();
};

const commitRenameLane = () => {
    const lane = editingLaneId.value ? song.value.getLane(editingLaneId.value) : null;
    if (lane && laneDraft.value.trim()) {
        lane.name = laneDraft.value.trim();
    }
    editingLaneId.value = null;
};

/** Ctrl+click on a lane's mute light solos it instead, like in FL Studio. */
const onMuteLight = (event: MouseEvent, lane: SongLane) => {
    if (event.ctrlKey || event.metaKey) {
        lane.isSolo = !lane.isSolo;
    } else {
        lane.isMuted = !lane.isMuted;
    }
};

const removeLane = (lane: SongLane, target: HTMLElement | null) => {
    if (!lane.clips.length) {
        song.value.removeLane(lane.id);
        return;
    }
    confirm.require({
        target: target ?? undefined,
        group: target ? undefined : 'confirmdialog',
        header: target ? undefined : 'Remove lane',
        message: `Remove "${lane.name}" with its ${lane.clips.length} ${lane.clips.length === 1 ? 'clip' : 'clips'}?`,
        acceptLabel: 'Remove',
        rejectLabel: 'Keep',
        acceptProps: { severity: 'danger', size: 'small' },
        rejectProps: { text: true, size: 'small' },
        accept: () => song.value.removeLane(lane.id),
    });
};

/* ---- menus ---- */

const menu = ref<{ x: number; y: number; title: string; items: SongMenuItem[] } | null>(null);

const openClipMenu = (event: MouseEvent, clip: SongClip) => {
    if (!isSelected(clip.id)) {
        selectClips([clip.id]);
        selectContainer(clip.containerId);
    }
    const ids = selectedIds.value;
    const many = ids.length > 1;
    const cueInside = currentStep.value > clip.start && currentStep.value < clip.start + clip.length;
    menu.value = {
        x: event.clientX,
        y: event.clientY,
        title: many ? `${ids.length} clips` : containerName(clip.containerId),
        items: [
            { label: 'Edit container', icon: 'mdi:application-edit-outline', action: () => editContainer(clip.containerId) },
            { label: 'Open in the track view', icon: 'mdi:dots-grid', action: () => openInTrackView(clip.containerId) },
            { label: 'Use as brush', icon: 'mdi:brush', action: () => setBrush(clip.containerId, clip.length) },
            {
                label: `Select all "${containerName(clip.containerId)}"`,
                icon: 'mdi:select-group',
                action: () => selectClips(song.value.clips.filter((other) => other.containerId === clip.containerId).map((other) => other.id)),
            },
            {},
            { label: 'Duplicate', icon: 'mdi:content-duplicate', shortcut: 'Ctrl+B', action: duplicateSelection },
            { label: 'Copy', icon: 'mdi:content-copy', shortcut: 'Ctrl+C', action: copySelection },
            { label: clip.isMuted ? 'Unmute' : 'Mute', icon: clip.isMuted ? 'mdi:volume-high' : 'mdi:volume-off', action: () => toggleMute(ids) },
            { label: 'Split at position marker', icon: 'mdi:content-cut', disabled: many || !cueInside, action: () => splitAtCue(clip) },
            { label: 'Make unique', icon: 'mdi:source-fork', disabled: many, action: () => void makeUnique(clip) },
            {},
            { label: many ? 'Delete clips' : 'Delete', icon: 'mdi:trash-can-outline', shortcut: 'Del', danger: true, action: () => deleteClips(ids) },
        ],
    };
};

const openLaneMenu = (event: MouseEvent, lane: SongLane) => {
    const index = song.value.lanes.indexOf(lane);
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    menu.value = {
        x: event.clientX,
        y: event.clientY,
        title: lane.name,
        items: [
            { label: 'Rename', icon: 'mdi:pencil-outline', action: () => void startRenameLane(lane) },
            { label: 'Mute', checked: lane.isMuted, action: () => (lane.isMuted = !lane.isMuted) },
            { label: 'Solo', checked: !!lane.isSolo, action: () => (lane.isSolo = !lane.isSolo) },
            {},
            { label: 'Insert lane above', icon: 'mdi:table-row-plus-before', action: () => song.value.addLane(undefined, index) },
            { label: 'Insert lane below', icon: 'mdi:table-row-plus-after', action: () => song.value.addLane(undefined, index + 1) },
            { label: 'Move up', icon: 'mdi:arrow-up', disabled: index === 0, action: () => song.value.moveLane(lane.id, -1) },
            { label: 'Move down', icon: 'mdi:arrow-down', disabled: index === song.value.lanes.length - 1, action: () => song.value.moveLane(lane.id, 1) },
            {},
            { label: 'Select all on lane', icon: 'mdi:select-all', disabled: !lane.clips.length, action: () => selectClips(lane.clips.map((clip) => clip.id)) },
            { label: 'Clear lane', icon: 'mdi:broom', disabled: !lane.clips.length, action: () => deleteClips(lane.clips.map((clip) => clip.id)) },
            {
                label: 'Delete lane',
                icon: 'mdi:trash-can-outline',
                danger: true,
                disabled: song.value.lanes.length === 1,
                action: () => removeLane(lane, button),
            },
        ],
    };
};

const openPickerMenu = (event: MouseEvent, container: TrackContainer) => {
    const count = song.value.countClips(container.id);
    menu.value = {
        x: event.clientX,
        y: event.clientY,
        title: container.name,
        items: [
            { label: 'Use as brush', icon: 'mdi:brush', action: () => pickBrush(container) },
            { label: 'Edit container', icon: 'mdi:application-edit-outline', action: () => editContainer(container.id) },
            { label: 'Open in the track view', icon: 'mdi:dots-grid', action: () => openInTrackView(container.id) },
            { label: 'Duplicate container', icon: 'mdi:content-duplicate', action: () => void duplicateContainer(container.id) },
            {
                label: `Select its clips (${count})`,
                icon: 'mdi:select-group',
                disabled: !count,
                action: () => selectClips(song.value.clips.filter((clip) => clip.containerId === container.id).map((clip) => clip.id)),
            },
        ],
    };
};

/* ---- pointer interactions ---- */

type Drag =
    | { kind: 'new'; containerId: string; length: number; start: number | null; laneId: string | null }
    | {
          kind: 'move';
          anchorId: string;
          grab: number;
          anchorLane: number;
          delta: number;
          laneDelta: number;
          clone: boolean;
          moved: boolean;
          x: number;
          y: number;
          placed: boolean;
      }
    | { kind: 'resize'; clipId: string; edge: 'start' | 'end' }
    | { kind: 'paint'; laneId: string; anchor: number; containerId: string; length: number; painted: string[] }
    | { kind: 'erase' }
    | { kind: 'mute'; value: boolean; touched: Set<string> }
    /* `clickId`: the clip a Ctrl+press started on; if the pointer never moves, that was a click, which toggles the clip. */
    | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: string[]; clickId: string | null; moved: boolean }
    | { kind: 'ruler'; from: number; x: number; moved: boolean }
    | { kind: 'loop-edge'; edge: 'start' | 'end' };

/** What the pointer is doing right now, null when idle. */
const drag = ref<Drag | null>(null);

/** Where the brush would land under the pointer, shown while hovering empty lane space with Draw or Paint. */
const hover = ref<{ laneId: string; start: number; valid: boolean } | null>(null);

/** Where the slice tool would cut, while hovering a clip. */
const cutMark = ref<{ clipId: string; step: number } | null>(null);

const laneBodies = () => [...(scroller.value?.querySelectorAll<HTMLElement>('[data-lane]') ?? [])];

/** The step under a horizontal screen position (unsnapped, may be negative left of the timeline). */
const stepAtX = (clientX: number): number => {
    const rect = scroller.value?.querySelector<HTMLElement>('.arr-ruler')?.getBoundingClientRect();
    return rect ? (clientX - rect.left) / stepPx.value : 0;
};

/** The lane under a vertical screen position, clamped to the first and last lane. */
const laneIndexAtY = (clientY: number): number => {
    const bodies = laneBodies();
    const index = bodies.findIndex((body) => clientY < body.getBoundingClientRect().bottom);
    return index === -1 ? bodies.length - 1 : index;
};

const snapTo = (step: number, free: boolean) => snapStep(step, free ? 1 : grid.value);

/** Runs a model edit with the grid switched off, for Alt-drags. */
const withGrid = <T,>(free: boolean, edit: () => T): T => {
    song.value.grid = free ? 1 : grid.value;
    try {
        return edit();
    } finally {
        song.value.grid = grid.value;
    }
};

const clipUnder = (clientX: number, clientY: number): SongClip | undefined => {
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-clip]');
    return element ? song.value.getClip(element.dataset.clip!) : undefined;
};

const beginDrag = (value: Drag) => {
    drag.value = value;
    hover.value = null;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', cancelDrag);
};

/** Pressing a container in the picker picks it as the brush, and dragging it onto a lane places it. */
const onPickerDown = (event: PointerEvent, container: TrackContainer) => {
    if (event.button !== 0) {
        return;
    }
    pickBrush(container);
    beginDrag({ kind: 'new', containerId: container.id, length: defaultLength(container), start: null, laneId: null });
};

const startMove = (event: PointerEvent, clip: SongClip, placed: boolean) => {
    const lane = song.value.laneOf(clip.id)!;
    if (!isSelected(clip.id)) {
        selectClips([clip.id]);
    }
    setBrush(clip.containerId, clip.length);
    beginDrag({
        kind: 'move',
        anchorId: clip.id,
        grab: stepAtX(event.clientX) - clip.start,
        anchorLane: song.value.lanes.indexOf(lane),
        delta: 0,
        laneDelta: 0,
        clone: false,
        moved: false,
        x: event.clientX,
        y: event.clientY,
        placed,
    });
};

const eraseAt = (clientX: number, clientY: number) => {
    const clip = clipUnder(clientX, clientY);
    if (clip) {
        deleteClips([clip.id]);
    }
};

const onClipDown = (event: PointerEvent, clip: SongClip) => {
    event.stopPropagation();
    closeMenu();
    if (event.button === 2) {
        if (tool.value === 'draw' || tool.value === 'paint' || tool.value === 'erase') {
            deleteClips([clip.id]);
            beginDrag({ kind: 'erase' });
        }
        return;
    }
    if (event.button !== 0) {
        return;
    }
    // Ctrl selects with every tool, starting on a clip as well as on empty space: a drag draws the box, a click toggles the clip.
    if (event.ctrlKey || event.metaKey) {
        startMarquee(event, true, clip.id);
        return;
    }

    switch (tool.value) {
        case 'erase':
            deleteClips([clip.id]);
            beginDrag({ kind: 'erase' });
            return;
        case 'mute': {
            const value = !clip.isMuted;
            clip.isMuted = value;
            beginDrag({ kind: 'mute', value, touched: new Set([clip.id]) });
            return;
        }
        case 'slice': {
            const right = withGrid(event.altKey, () => song.value.splitClip(clip.id, stepAtX(event.clientX)));
            if (right) {
                selectClips([right.id]);
            }
            return;
        }
        default:
            startMove(event, clip, false);
    }
};

const onClipContextMenu = (event: MouseEvent, clip: SongClip) => {
    // The drawing tools delete on a right-click (done on pointerdown); the others open the clip menu.
    if (tool.value === 'mute' || tool.value === 'slice' || tool.value === 'select') {
        openClipMenu(event, clip);
    }
};

const onHandleDown = (event: PointerEvent, clip: SongClip, edge: 'start' | 'end') => {
    if (event.button !== 0 || (tool.value !== 'draw' && tool.value !== 'paint' && tool.value !== 'select')) {
        return;
    }
    event.stopPropagation();
    closeMenu();
    selectClips([clip.id]);
    beginDrag({ kind: 'resize', clipId: clip.id, edge });
};

/** How far (px) a Ctrl+press has to travel before it draws a box instead of toggling the clip it started on. */
const MARQUEE_THRESHOLD = 4;

const startMarquee = (event: PointerEvent, additive: boolean, clickId: string | null = null) => {
    const inner = scroller.value!.querySelector<HTMLElement>('.arr-inner')!.getBoundingClientRect();
    const x = event.clientX - inner.left;
    const y = event.clientY - inner.top;
    beginDrag({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: additive ? [...selectedIds.value] : [], clickId, moved: false });
    if (!additive) {
        selectClips([]);
    }
};

/** Pressing on empty lane space: what happens depends on the tool. */
const onLaneDown = (event: PointerEvent, lane: SongLane) => {
    if (event.target !== event.currentTarget) {
        return;
    }
    closeMenu();
    if (event.button === 2) {
        if (tool.value === 'draw' || tool.value === 'paint' || tool.value === 'erase') {
            beginDrag({ kind: 'erase' });
        }
        return;
    }
    if (event.button !== 0) {
        return;
    }
    if (event.ctrlKey || event.metaKey || tool.value === 'select') {
        startMarquee(event, event.ctrlKey || event.metaKey);
        return;
    }

    selectClips([]);
    const step = snapTo(stepAtX(event.clientX), event.altKey);
    const pattern = brush.value && containerById(brush.value.containerId) ? brush.value : null;

    if (tool.value === 'erase') {
        beginDrag({ kind: 'erase' });
    } else if (tool.value === 'paint' && pattern) {
        const paint: Drag = { kind: 'paint', laneId: lane.id, anchor: step, ...pattern, painted: [] };
        beginDrag(paint);
        paintTo(paint, step);
    } else if (tool.value === 'draw' && pattern) {
        const clip = withGrid(true, () => song.value.addClip(lane.id, pattern.containerId, step, pattern.length));
        if (clip) {
            startMove(event, clip, true);
        }
    }
};

/** Lays the brush down from the anchor towards the pointer, one clip after another, only where the lane is free. */
const paintTo = (paint: Extract<Drag, { kind: 'paint' }>, pointerStep: number) => {
    const { length, anchor } = paint;
    const wanted: number[] = [];
    if (pointerStep >= anchor) {
        for (let start = anchor; start <= pointerStep; start += length) {
            wanted.push(start);
        }
    } else {
        for (let start = anchor; start + length > pointerStep && start >= 0; start -= length) {
            wanted.push(start);
        }
    }

    for (const id of [...paint.painted]) {
        const clip = song.value.getClip(id);
        if (!clip || !wanted.includes(clip.start)) {
            song.value.removeClip(id);
            paint.painted.splice(paint.painted.indexOf(id), 1);
        }
    }
    for (const start of wanted) {
        if (!paint.painted.some((id) => song.value.getClip(id)?.start === start)) {
            const clip = withGrid(true, () => song.value.addClip(paint.laneId, paint.containerId, start, length));
            if (clip) {
                paint.painted.push(clip.id);
            }
        }
    }
};

/** The ruler: a click moves the song position marker, a drag draws the loop region. */
const onRulerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
        return;
    }
    closeMenu();
    beginDrag({ kind: 'ruler', from: Math.max(0, stepAtX(event.clientX)), x: event.clientX, moved: false });
};

const onLoopEdgeDown = (event: PointerEvent, edge: 'start' | 'end') => {
    if (event.button !== 0) {
        return;
    }
    event.stopPropagation();
    beginDrag({ kind: 'loop-edge', edge });
};

let lastPointer: PointerEvent | null = null;

const onDragMove = (event: PointerEvent) => {
    lastPointer = event;
    updateDrag(event);
    startAutoScroll();
};

const updateDrag = (event: PointerEvent) => {
    const current = drag.value;
    if (!current) {
        return;
    }
    const free = event.altKey;

    switch (current.kind) {
        case 'paint':
            paintTo(current, snapTo(stepAtX(event.clientX), free));
            return;
        case 'erase':
            eraseAt(event.clientX, event.clientY);
            return;
        case 'mute': {
            const clip = clipUnder(event.clientX, event.clientY);
            if (clip && !current.touched.has(clip.id)) {
                current.touched.add(clip.id);
                clip.isMuted = current.value;
            }
            return;
        }
        case 'resize':
            withGrid(free, () =>
                current.edge === 'end'
                    ? song.value.setClipEnd(current.clipId, stepAtX(event.clientX))
                    : song.value.setClipStart(current.clipId, stepAtX(event.clientX)),
            );
            return;
        case 'marquee': {
            const inner = scroller.value!.querySelector<HTMLElement>('.arr-inner')!.getBoundingClientRect();
            current.x1 = event.clientX - inner.left;
            current.y1 = event.clientY - inner.top;
            if (!current.moved && Math.hypot(current.x1 - current.x0, current.y1 - current.y0) < MARQUEE_THRESHOLD) {
                return;
            }
            current.moved = true;
            const left = inner.left + Math.min(current.x0, current.x1);
            const right = inner.left + Math.max(current.x0, current.x1);
            const top = inner.top + Math.min(current.y0, current.y1);
            const bottom = inner.top + Math.max(current.y0, current.y1);
            const hit = [...scroller.value!.querySelectorAll<HTMLElement>('[data-clip]')]
                .filter((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
                })
                .map((element) => element.dataset.clip!);
            selectClips([...new Set([...current.base, ...hit])]);
            return;
        }
        case 'ruler': {
            if (!current.moved && Math.abs(event.clientX - current.x) < 4) {
                return;
            }
            current.moved = true;
            const to = Math.max(0, stepAtX(event.clientX));
            const start = snapTo(Math.min(current.from, to), free);
            const end = Math.max(start + (free ? 1 : grid.value), snapTo(Math.max(current.from, to), free));
            songLoop.value = { start, end };
            return;
        }
        case 'loop-edge': {
            const loop = songLoop.value;
            if (!loop) {
                return;
            }
            const unit = free ? 1 : grid.value;
            const step = snapTo(stepAtX(event.clientX), free);
            songLoop.value =
                current.edge === 'start'
                    ? { start: Math.min(step, loop.end - unit), end: loop.end }
                    : { start: loop.start, end: Math.max(step, loop.start + unit) };
            return;
        }
        case 'new': {
            const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-lane]');
            current.laneId = over?.dataset.lane ?? null;
            current.start = over ? snapTo(stepAtX(event.clientX), free) : null;
            return;
        }
        case 'move': {
            if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) {
                return;
            }
            current.moved = true;
            const anchor = song.value.getClip(current.anchorId);
            if (!anchor) {
                return;
            }
            const ids = selectedIds.value;
            const clips = ids.map((id) => song.value.getClip(id)!);
            const laneIndices = ids.map((id) => song.value.lanes.indexOf(song.value.laneOf(id)!));
            const minStart = Math.min(...clips.map((clip) => clip.start));
            const wantedStart = snapTo(stepAtX(event.clientX) - current.grab, free);
            current.delta = Math.max(-minStart, wantedStart - anchor.start);
            current.laneDelta = clamp(
                laneIndexAtY(event.clientY) - current.anchorLane,
                -Math.min(...laneIndices),
                song.value.lanes.length - 1 - Math.max(...laneIndices),
            );
            current.clone = event.shiftKey;
            return;
        }
    }
};

/** The clips a move or clone would produce, drawn where they would land. */
const ghosts = computed(() => {
    const current = drag.value;
    if (current?.kind === 'new') {
        if (current.laneId === null || current.start === null) {
            return [];
        }
        return [
            {
                laneId: current.laneId,
                start: current.start,
                length: current.length,
                containerId: current.containerId,
                valid: song.value.isFree(current.laneId, current.start, current.length),
            },
        ];
    }
    if (current?.kind !== 'move' || !current.moved || (current.delta === 0 && current.laneDelta === 0)) {
        return [];
    }
    const ids = selectedIds.value;
    const valid = current.clone
        ? song.value.canCopyClips(ids, current.delta, current.laneDelta)
        : song.value.canMoveClips(ids, current.delta, current.laneDelta);
    return ids.map((id) => {
        const clip = song.value.getClip(id)!;
        const lane = song.value.lanes[song.value.lanes.indexOf(song.value.laneOf(id)!) + current.laneDelta]!;
        return { laneId: lane.id, start: clip.start + current.delta, length: clip.length, containerId: clip.containerId, valid };
    });
});

const ghostsOn = (laneId: string) => ghosts.value.filter((ghost) => ghost.laneId === laneId);

/** Clips being moved (not cloned) fade while their ghosts show where they go. */
const isLifted = (clip: SongClip) => drag.value?.kind === 'move' && !drag.value.clone && ghosts.value.length > 0 && isSelected(clip.id);

const onDragEnd = (event: PointerEvent) => {
    const current = drag.value;
    if (current?.kind === 'new' && current.laneId !== null && current.start !== null) {
        const clip = withGrid(true, () => song.value.addClip(current.laneId!, current.containerId, current.start!, current.length));
        if (clip) {
            selectClips([clip.id]);
        }
    } else if (current?.kind === 'move') {
        if (!current.moved) {
            // A plain click on a clip that was part of a bigger selection selects just that clip.
            if (!current.placed && selectedIds.value.length > 1) {
                selectClips([current.anchorId]);
            }
        } else if (current.delta !== 0 || current.laneDelta !== 0) {
            if (current.clone) {
                const copies = song.value.copyClips(selectedIds.value, current.delta, current.laneDelta);
                if (copies) {
                    selectClips(copies.map((clip) => clip.id));
                }
            } else {
                song.value.moveClips(selectedIds.value, current.delta, current.laneDelta);
            }
        }
    } else if (current?.kind === 'marquee' && !current.moved && current.clickId) {
        const id = current.clickId;
        selectClips(isSelected(id) ? selectedIds.value.filter((other) => other !== id) : [...selectedIds.value, id]);
    } else if (current?.kind === 'ruler' && !current.moved) {
        cueSong(snapTo(current.from, event.altKey));
    }
    cancelDrag();
};

const cancelDrag = () => {
    drag.value = null;
    stopAutoScroll();
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', cancelDrag);
};

/* While dragging near an edge of the timeline, it scrolls along. */
let scrollFrame = 0;
const EDGE = 40;

const autoScrollStep = () => {
    const element = scroller.value;
    const event = lastPointer;
    scrollFrame = 0;
    if (!element || !event || !drag.value || drag.value.kind === 'new') {
        return;
    }
    const rect = element.getBoundingClientRect();
    const head = element.querySelector<HTMLElement>('.arr-corner')?.offsetWidth ?? 0;
    const speed = (distance: number) => Math.ceil(((EDGE - distance) / EDGE) * 18);
    let dx = 0;
    let dy = 0;
    if (event.clientX > rect.right - EDGE) {
        dx = speed(rect.right - event.clientX);
    } else if (event.clientX < rect.left + head + EDGE && element.scrollLeft > 0) {
        dx = -speed(event.clientX - rect.left - head);
    }
    if (event.clientY > rect.bottom - EDGE) {
        dy = speed(rect.bottom - event.clientY);
    }
    if (!dx && !dy) {
        return;
    }
    element.scrollBy(dx, dy);
    updateDrag(event);
    scrollFrame = requestAnimationFrame(autoScrollStep);
};

const startAutoScroll = () => {
    if (!scrollFrame) {
        scrollFrame = requestAnimationFrame(autoScrollStep);
    }
};

const stopAutoScroll = () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    lastPointer = null;
};

/** Hovering, not dragging: the brush preview for Draw and Paint, the cut line for Slice. */
const onHover = (event: PointerEvent) => {
    if (drag.value) {
        return;
    }
    const target = event.target as HTMLElement;
    if (tool.value === 'slice') {
        const clip = clipUnder(event.clientX, event.clientY);
        cutMark.value = clip ? { clipId: clip.id, step: snapTo(stepAtX(event.clientX), event.altKey) } : null;
    }
    const laneId = target.dataset.lane;
    const pattern = brush.value;
    if ((tool.value === 'draw' || tool.value === 'paint') && laneId && pattern && !event.ctrlKey) {
        const start = snapTo(stepAtX(event.clientX), event.altKey);
        hover.value = { laneId, start, valid: song.value.isFree(laneId, start, pattern.length) };
    } else {
        hover.value = null;
    }
};

const onLeave = () => {
    hover.value = null;
    cutMark.value = null;
};

/* ---- zoom and scrolling ---- */

const headWidth = () => scroller.value?.querySelector<HTMLElement>('.arr-corner')?.offsetWidth ?? 0;

/** Zooms around a screen x (the pointer), or the left edge of the timeline. */
const zoomTo = async (value: number, clientX?: number) => {
    const element = scroller.value;
    const next = clamp(value, MIN_STEP_PX, MAX_STEP_PX);
    if (!element || next === stepPx.value) {
        stepPx.value = next;
        return;
    }
    const rect = element.getBoundingClientRect();
    const offset = clientX === undefined ? 0 : clientX - rect.left - headWidth();
    const step = (element.scrollLeft + offset) / stepPx.value;
    stepPx.value = next;
    await nextTick();
    element.scrollLeft = Math.max(0, step * next - offset);
};

const zoomBy = (factor: number, clientX?: number) => void zoomTo(stepPx.value * factor, clientX);

/** Fits the whole song (or 16 bars of an empty one) into the view. */
const zoomToFit = async () => {
    const element = scroller.value;
    if (!element) {
        return;
    }
    const steps = Math.max(song.value.length, 16 * SONG_STEPS_PER_BAR);
    stepPx.value = clamp((element.clientWidth - headWidth() - 24) / steps, MIN_STEP_PX, MAX_STEP_PX);
    await nextTick();
    element.scrollLeft = 0;
};

const laneTaller = (direction: 1 | -1) => {
    const index = LANE_HEIGHTS.indexOf(laneHeight.value);
    laneHeight.value = LANE_HEIGHTS[clamp(index + direction, 0, LANE_HEIGHTS.length - 1)]!;
};

const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX);
    } else if (event.altKey) {
        event.preventDefault();
        laneTaller(event.deltaY < 0 ? 1 : -1);
    }
};

/*
 * The playhead moves every step. The marker and the beam read it from a CSS variable on the timeline, and the position
 * readout is a `LiveText`, so this big template never re-renders just because the song moved on.
 */
const timelineInner = ref<HTMLElement | null>(null);
watchPostEffect(() => timelineInner.value?.style.setProperty('--jl-playhead', String(currentStep.value)));
const positionText = (): string => formatStep(currentStep.value);

/* The playhead stays in view while the song plays. */
watch(currentStep, (step) => {
    const element = scroller.value;
    if (!isPlaying.value || !follow.value || !element || drag.value) {
        return;
    }
    const x = step * stepPx.value;
    const visible = element.clientWidth - headWidth();
    if (x < element.scrollLeft || x > element.scrollLeft + visible - 32) {
        element.scrollTo({ left: Math.max(0, x - 32) });
    }
});

/* ---- loop region ---- */

const toggleLoop = () => {
    if (songLoop.value) {
        songLoop.value = null;
    } else if (selectionSpan.value) {
        songLoop.value = { ...selectionSpan.value };
    } else {
        const start = snapStep(currentStep.value, SONG_STEPS_PER_BAR);
        songLoop.value = { start, end: start + 4 * SONG_STEPS_PER_BAR };
    }
};

/* ---- keyboard ---- */

const isTypingTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return !!element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable);
};

const TOOL_KEYS: Record<string, Tool> = { p: 'draw', b: 'paint', d: 'erase', t: 'mute', c: 'slice', e: 'select' };

const onKeyDown = (event: KeyboardEvent) => {
    // While a container window has the keyboard, keys belong to its tracks, not to the playlist.
    if (isTypingTarget(event.target) || menu.value || activeWindowId.value) {
        return;
    }
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;

    if (event.key === 'Escape') {
        cancelDrag();
        selectClips([]);
        return;
    }
    if (!modifier && !event.altKey && TOOL_KEYS[key]) {
        tool.value = TOOL_KEYS[key]!;
        return;
    }
    if (event.key === 'Home') {
        event.preventDefault();
        cueSong(songLoop.value?.start ?? 0);
        scroller.value?.scrollTo({ left: 0 });
        return;
    }
    if (modifier && key === 'a') {
        event.preventDefault();
        selectAll();
        return;
    }
    if (modifier && key === 'v') {
        event.preventDefault();
        paste();
        return;
    }

    const ids = selectedIds.value;
    if (!ids.length) {
        return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteClips(ids);
    } else if (modifier && (key === 'b' || key === 'd')) {
        event.preventDefault();
        duplicateSelection();
    } else if (modifier && key === 'c') {
        event.preventDefault();
        copySelection();
    } else if (modifier && key === 'x') {
        event.preventDefault();
        copySelection();
        deleteClips(ids);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        nudgeSelection((event.shiftKey ? SONG_STEPS_PER_BAR : grid.value) * (event.key === 'ArrowLeft' ? -1 : 1), 0);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        nudgeSelection(0, event.key === 'ArrowUp' ? -1 : 1);
    }
};

const closeMenu = () => (menu.value = null);

onMounted(() => {
    window.addEventListener('keydown', onKeyDown);
    resizeObserver = new ResizeObserver(([entry]) => (viewportWidth.value = entry?.contentRect.width ?? 0));
    watch(
        scroller,
        (element, previous) => {
            if (previous) {
                resizeObserver?.unobserve(previous);
            }
            if (element) {
                resizeObserver?.observe(element);
            }
        },
        { immediate: true },
    );
});

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown);
    resizeObserver?.disconnect();
    cancelDrag();
});

const marqueeStyle = computed(() => {
    const current = drag.value;
    if (current?.kind !== 'marquee') {
        return null;
    }
    return {
        left: `${Math.min(current.x0, current.x1)}px`,
        top: `${Math.min(current.y0, current.y1)}px`,
        width: `${Math.abs(current.x1 - current.x0)}px`,
        height: `${Math.abs(current.y1 - current.y0)}px`,
    };
});

const statusText = computed(() => {
    const count = selectedIds.value.length;
    if (count) {
        return `${count} ${count === 1 ? 'clip' : 'clips'} selected · Del deletes · Ctrl+B duplicates · arrows nudge`;
    }
    return TOOLS.find((item) => item.key === tool.value)!.hint;
});
</script>

<template>
    <div class="page songpage">
        <div v-if="!hasTracks" class="hero">
            <div>
                <h2 class="hero-title">Nothing to arrange yet</h2>
                <p class="hero-text">A song is built from track containers. Put a few tracks into one first, then lay it out.</p>
            </div>
            <div class="flex flex-wrap justify-center gap-3">
                <button type="button" class="playbtn playbtn--wide" @click="editContainer(currentContainer.id)">
                    <Icon icon="mdi:application-edit-outline" class="w-5 h-5" />
                    <span>Add tracks to {{ currentContainer.name }}</span>
                </button>
                <RouterLink :to="{ name: 'app.index' }" class="chip">
                    <Icon icon="mdi:dots-grid" class="w-4 h-4" />
                    <span>Go to the track view</span>
                </RouterLink>
            </div>
        </div>

        <template v-else>
            <div class="toolbar songbar">
                <button
                    type="button"
                    class="iconbtn"
                    :data-active="isPickerOpen"
                    :aria-pressed="isPickerOpen"
                    aria-label="Container picker"
                    v-tooltip.bottom="isPickerOpen ? 'Hide the containers' : 'Show the containers'"
                    @click="isPickerOpen = !isPickerOpen"
                >
                    <Icon icon="mdi:dock-left" class="w-4 h-4" />
                </button>

                <div class="songtools" role="radiogroup" aria-label="Tool">
                    <button
                        v-for="item in TOOLS"
                        :key="item.key"
                        type="button"
                        class="songtool"
                        role="radio"
                        :aria-checked="tool === item.key"
                        :aria-label="item.label"
                        :data-active="tool === item.key"
                        :data-tool="item.key"
                        v-tooltip.bottom="{ value: `${item.label} (${item.shortcut}) · ${item.hint}`, showDelay: 300 }"
                        @click="tool = item.key"
                    >
                        <Icon :icon="item.icon" class="w-4 h-4" />
                        <kbd class="songtool-key">{{ item.shortcut }}</kbd>
                    </button>
                </div>

                <label class="songfield" v-tooltip.bottom="{ value: 'Where clips land. Hold Alt while dragging to ignore it.', showDelay: 500 }">
                    <Icon icon="mdi:magnet" class="w-4 h-4" />
                    <select v-model.number="grid" class="select select--tight" aria-label="Snap">
                        <option v-for="option in GRIDS" :key="option.steps" :value="option.steps">{{ option.label }}</option>
                    </select>
                </label>

                <span class="vrule"></span>

                <button
                    type="button"
                    class="iconbtn"
                    :data-active="!!songLoop"
                    :aria-pressed="!!songLoop"
                    aria-label="Loop region"
                    v-tooltip.bottom="songLoop ? 'Loop on: click to play the whole song' : 'Loop the selection (or drag on the ruler)'"
                    @click="toggleLoop"
                >
                    <Icon icon="mdi:repeat" class="w-4 h-4" />
                </button>
                <button
                    type="button"
                    class="iconbtn"
                    :data-active="follow"
                    :aria-pressed="follow"
                    aria-label="Follow playhead"
                    v-tooltip.bottom="follow ? 'Following the playhead' : 'Follow the playhead'"
                    @click="follow = !follow"
                >
                    <Icon icon="mdi:arrow-right-bold-box-outline" class="w-4 h-4" />
                </button>

                <span class="vrule"></span>

                <div class="songzoom" aria-label="Zoom">
                    <button
                        type="button"
                        class="iconbtn"
                        aria-label="Zoom out"
                        v-tooltip.bottom="'Zoom out (Ctrl+wheel)'"
                        :disabled="stepPx <= MIN_STEP_PX"
                        @click="zoomBy(1 / 1.3)"
                    >
                        <Icon icon="mdi:magnify-minus-outline" class="w-4 h-4" />
                    </button>
                    <input
                        v-model.number="stepPx"
                        class="songzoom-range"
                        type="range"
                        :min="MIN_STEP_PX"
                        :max="MAX_STEP_PX"
                        step="0.5"
                        aria-label="Horizontal zoom"
                    />
                    <button
                        type="button"
                        class="iconbtn"
                        aria-label="Zoom in"
                        v-tooltip.bottom="'Zoom in (Ctrl+wheel)'"
                        :disabled="stepPx >= MAX_STEP_PX"
                        @click="zoomBy(1.3)"
                    >
                        <Icon icon="mdi:magnify-plus-outline" class="w-4 h-4" />
                    </button>
                    <button type="button" class="iconbtn" aria-label="Fit song" v-tooltip.bottom="'Fit the song into view'" @click="zoomToFit">
                        <Icon icon="mdi:arrow-expand-horizontal" class="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        class="iconbtn"
                        aria-label="Lower lanes"
                        v-tooltip.bottom="'Lower lanes (Alt+wheel)'"
                        :disabled="laneHeight === LANE_HEIGHTS[0]"
                        @click="laneTaller(-1)"
                    >
                        <Icon icon="mdi:arrow-collapse-vertical" class="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        class="iconbtn"
                        aria-label="Taller lanes"
                        v-tooltip.bottom="'Taller lanes (Alt+wheel)'"
                        :disabled="laneHeight === LANE_HEIGHTS[LANE_HEIGHTS.length - 1]"
                        @click="laneTaller(1)"
                    >
                        <Icon icon="mdi:arrow-expand-vertical" class="w-4 h-4" />
                    </button>
                </div>

                <div class="flex-1"></div>

                <span class="toolbar-meta songbar-meta">
                    <b>{{ bars }}</b> {{ bars === 1 ? 'bar' : 'bars' }} <i>·</i> <b>{{ duration }}</b> <i>·</i> <b>{{ bpm }}</b> BPM
                </span>
                <button type="button" class="chip" v-tooltip.bottom="'Draw a value of the master, a container or a track over the song'" @click="addAutomation">
                    <Icon icon="mdi:chart-bell-curve-cumulative" class="w-4 h-4" />
                    <span>Automate</span>
                </button>
            </div>

            <div class="songbody">
                <aside v-if="isPickerOpen" class="picker" aria-label="Containers">
                    <div class="picker-head">
                        <span class="eyebrow">Containers</span>
                        <button type="button" class="iconbtn iconbtn--tiny" aria-label="New container" v-tooltip.right="'New container'" @click="newContainer">
                            <Icon icon="mdi:plus" class="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <div class="picker-list">
                        <div
                            v-for="container in containers"
                            :key="container.id"
                            class="picker-item"
                            :style="{ '--jl-clip-hue': containerHue(container.id) }"
                            :data-brush="brush?.containerId === container.id"
                            :data-empty="!container.tracks.length"
                            role="button"
                            tabindex="0"
                            :aria-label="`${container.name}: click to draw with it, drag onto a lane to place it`"
                            :aria-pressed="brush?.containerId === container.id"
                            @pointerdown="onPickerDown($event, container)"
                            @keydown.enter.prevent="pickBrush(container)"
                            @dblclick="editContainer(container.id)"
                            @contextmenu.prevent="openPickerMenu($event, container)"
                        >
                            <span class="picker-swatch"></span>
                            <span class="picker-text">
                                <span class="picker-name">{{ container.name }}</span>
                                <span class="picker-meta">
                                    <span class="ctab-dots" aria-hidden="true">
                                        <span
                                            v-for="track in container.tracks.slice(0, 5)"
                                            :key="track.id"
                                            class="ctab-dot"
                                            :style="{ background: TRACK_META[track.type].accent }"
                                        ></span>
                                    </span>
                                    {{ defaultLength(container) / SONG_STEPS_PER_BAR }} {{ defaultLength(container) === SONG_STEPS_PER_BAR ? 'bar' : 'bars' }}
                                    <template v-if="song.countClips(container.id)"> · {{ song.countClips(container.id) }}×</template>
                                </span>
                            </span>
                        </div>
                    </div>
                    <p class="picker-hint">Click to pick the brush, drag onto a lane, double-click to edit its tracks.</p>
                </aside>

                <div
                    ref="scroller"
                    class="arranger"
                    :class="[`arranger--${tool}`, { 'arranger--dragging': drag?.kind === 'move' && drag.moved, 'arranger--zoomed': stepPx >= 9 }]"
                    :style="timelineStyle"
                    @wheel="onWheel"
                    @contextmenu.prevent
                >
                    <div ref="timelineInner" class="arr-inner">
                        <div class="arr-row arr-row--ruler">
                            <div class="arr-corner">
                                <span class="arr-pos" v-tooltip.bottom="{ value: 'Position (bar.beat)', showDelay: 500 }"><LiveText :text="positionText" /></span>
                                <span class="arr-grid">{{ GRIDS.find((option) => option.steps === grid)?.label }}</span>
                            </div>
                            <div class="arr-ruler" @pointerdown="onRulerDown" @dblclick="songLoop = null">
                                <span
                                    v-for="bar in totalBars"
                                    :key="bar"
                                    class="arr-bar"
                                    :data-inside="bar <= bars"
                                    :data-label="(bar - 1) % labelEvery === 0"
                                    >{{ (bar - 1) % labelEvery === 0 ? bar : '' }}</span
                                >
                                <div
                                    v-if="songLoop"
                                    class="arr-loop"
                                    :style="spanStyle({ start: songLoop.start, length: songLoop.end - songLoop.start })"
                                    v-tooltip.bottom="{ value: 'Loop region · double-click the ruler to remove', showDelay: 600 }"
                                >
                                    <span class="arr-loop-edge arr-loop-edge--start" @pointerdown="onLoopEdgeDown($event, 'start')"></span>
                                    <span class="arr-loop-edge arr-loop-edge--end" @pointerdown="onLoopEdgeDown($event, 'end')"></span>
                                </div>
                                <span
                                    class="arr-marker"
                                    :data-playing="isPlaying"
                                    :style="{ left: 'calc(var(--jl-playhead) * var(--jl-song-step))' }"
                                    aria-hidden="true"
                                ></span>
                            </div>
                        </div>

                        <div v-for="lane in song.lanes" :key="lane.id" class="arr-row" :class="{ 'arr-row--muted': !isAudible(lane) }">
                            <div class="arr-head" @contextmenu.prevent="openLaneMenu($event, lane)">
                                <button
                                    type="button"
                                    class="lane-led"
                                    :data-on="!lane.isMuted"
                                    :aria-pressed="!lane.isMuted"
                                    :aria-label="lane.isMuted ? 'Unmute lane' : 'Mute lane'"
                                    v-tooltip.right="{ value: 'Mute (Ctrl+click solos)', showDelay: 500 }"
                                    @click="onMuteLight($event, lane)"
                                ></button>
                                <div class="arr-head-main">
                                    <input
                                        v-if="editingLaneId === lane.id"
                                        ref="laneInput"
                                        v-model="laneDraft"
                                        class="ctab-input"
                                        aria-label="Lane name"
                                        @keydown.enter="commitRenameLane"
                                        @keydown.esc="editingLaneId = null"
                                        @blur="commitRenameLane"
                                    />
                                    <span v-else class="arr-head-name" :title="lane.name" @dblclick="startRenameLane(lane)">{{ lane.name }}</span>
                                </div>
                                <button
                                    type="button"
                                    class="lane-solo"
                                    :data-on="!!lane.isSolo"
                                    :aria-pressed="!!lane.isSolo"
                                    aria-label="Solo lane"
                                    v-tooltip.bottom="{ value: 'Solo', showDelay: 500 }"
                                    @click="lane.isSolo = !lane.isSolo"
                                >
                                    S
                                </button>
                                <button type="button" class="iconbtn iconbtn--tiny" aria-label="Lane menu" @click="openLaneMenu($event, lane)">
                                    <Icon icon="mdi:dots-vertical" class="w-3.5 h-3.5" />
                                </button>
                            </div>

                            <div class="arr-lane" :data-lane="lane.id" @pointerdown="onLaneDown($event, lane)" @pointermove="onHover" @pointerleave="onLeave">
                                <div
                                    v-if="hover && hover.laneId === lane.id && brush"
                                    class="clip clip--hover"
                                    :data-valid="hover.valid"
                                    :style="{ ...spanStyle({ start: hover.start, length: brush.length }), '--jl-clip-hue': containerHue(brush.containerId) }"
                                    aria-hidden="true"
                                ></div>

                                <div
                                    v-for="clip in lane.clips"
                                    :key="clip.id"
                                    class="clip"
                                    :class="{ 'clip--selected': isSelected(clip.id), 'clip--lifted': isLifted(clip), 'clip--muted': clip.isMuted }"
                                    :style="{ ...spanStyle(clip), '--jl-clip-hue': containerHue(clip.containerId) }"
                                    :data-clip="clip.id"
                                    role="button"
                                    tabindex="0"
                                    :aria-pressed="isSelected(clip.id)"
                                    :aria-label="`${containerName(clip.containerId)}, bar ${formatStep(clip.start)}, ${clip.length / SONG_STEPS_PER_BAR} bars${clip.isMuted ? ', muted' : ''}`"
                                    @pointerdown="onClipDown($event, clip)"
                                    @pointermove="onHover"
                                    @contextmenu.prevent.stop="onClipContextMenu($event, clip)"
                                    @keydown.enter.self="selectClips([clip.id])"
                                    @dblclick="editContainer(clip.containerId)"
                                >
                                    <div class="clip-head">
                                        <button
                                            type="button"
                                            class="clip-menu"
                                            aria-label="Clip menu"
                                            @pointerdown.stop
                                            @click.stop="openClipMenu($event, clip)"
                                            @dblclick.stop
                                        >
                                            <Icon icon="mdi:menu-down" class="w-3.5 h-3.5" />
                                        </button>
                                        <span class="clip-title">{{ containerName(clip.containerId) }}</span>
                                        <Icon v-if="clip.isMuted" icon="mdi:volume-off" class="clip-flag" />
                                    </div>
                                    <ClipPreview
                                        v-if="containerById(clip.containerId) && laneHeight > 40"
                                        :container="containerById(clip.containerId)!"
                                        :offset="clip.offset"
                                        :length="clip.length"
                                    />
                                    <span class="note-handle note-handle--start" @pointerdown="onHandleDown($event, clip, 'start')"></span>
                                    <span class="note-handle note-handle--end" @pointerdown="onHandleDown($event, clip, 'end')"></span>
                                    <span
                                        v-if="tool === 'slice' && cutMark?.clipId === clip.id"
                                        class="clip-cut"
                                        :style="{ left: `calc(${cutMark.step - clip.start} * var(--jl-song-step))` }"
                                    ></span>
                                </div>

                                <div
                                    v-for="(ghost, index) in ghostsOn(lane.id)"
                                    :key="`ghost-${index}`"
                                    class="clip clip--ghost"
                                    :data-valid="ghost.valid"
                                    :style="{ ...spanStyle(ghost), '--jl-clip-hue': containerHue(ghost.containerId) }"
                                    aria-hidden="true"
                                >
                                    <div class="clip-head">
                                        <span class="clip-title">{{ containerName(ghost.containerId) }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="arr-row arr-row--add">
                            <div class="arr-head arr-head--add">
                                <button type="button" class="chip chip--small" @click="song.addLane()">
                                    <Icon icon="mdi:plus" class="w-3.5 h-3.5" />
                                    <span>Lane</span>
                                </button>
                            </div>
                            <div class="arr-lane arr-lane--add"></div>
                        </div>

                        <template v-if="song.automation.length">
                            <div class="arr-row arr-row--section">
                                <div class="arr-corner arr-corner--section">
                                    <span class="eyebrow">Automation</span>
                                    <span class="ctab-count">{{ song.automation.length }}</span>
                                </div>
                                <div class="arr-section-line"></div>
                            </div>
                            <SongAutomationLane
                                v-for="(lane, index) in song.automation"
                                :key="lane.id"
                                :lane="lane"
                                :total-steps="totalSteps"
                                :hue="automationHue(index)"
                                @remove="removeAutomation(lane)"
                            />
                        </template>

                        <div class="arr-overlay" aria-hidden="true">
                            <div v-if="song.length" class="arr-end" :style="{ left: `calc(${song.length} * var(--jl-song-step))` }"></div>
                            <div
                                v-if="songLoop"
                                class="arr-loopzone"
                                :style="spanStyle({ start: songLoop.start, length: songLoop.end - songLoop.start })"
                            ></div>
                            <div class="arr-playhead" :data-playing="isPlaying" :style="{ left: 'calc(var(--jl-playhead) * var(--jl-song-step))' }"></div>
                        </div>

                        <div v-if="marqueeStyle" class="arr-marquee" :style="marqueeStyle" aria-hidden="true"></div>

                        <div v-if="song.isEmpty && !drag" class="arr-empty">
                            <span class="song-hint">Pick a container on the left, then click on a lane to place it, or drag it in.</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="songstatus" aria-live="polite">
                <Icon :icon="TOOLS.find((item) => item.key === tool)!.icon" class="w-3.5 h-3.5" />
                <span>{{ statusText }}</span>
                <span class="flex-1"></span>
                <span v-if="brush" class="songstatus-brush" :style="{ '--jl-clip-hue': containerHue(brush.containerId) }">
                    <span class="picker-swatch"></span>
                    {{ containerName(brush.containerId) }} · {{ brush.length / SONG_STEPS_PER_BAR }} {{ brush.length === SONG_STEPS_PER_BAR ? 'bar' : 'bars' }}
                </span>
                <span v-if="songLoop" class="songstatus-loop"
                    ><Icon icon="mdi:repeat" class="w-3.5 h-3.5" /> {{ formatStep(songLoop.start) }} – {{ formatStep(songLoop.end) }}</span
                >
            </div>

            <SongMenu v-if="menu" :items="menu.items" :x="menu.x" :y="menu.y" :title="menu.title" @close="closeMenu" />
        </template>

        <ContainerWindows ref="windowLayer" />
    </div>
</template>
