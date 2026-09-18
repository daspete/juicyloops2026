<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useConfirm } from 'primevue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { STEP_COUNT } from '@/juicyloops/constants';
import type { SongAutomationLane as SongAutomationLaneModel } from '@/juicyloops/automation';
import { SONG_SNAP, SONG_STEPS_PER_BAR, snapStep, type SongClip, type SongLane } from '@/juicyloops/song';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import { TRACK_META } from '../tracks/trackMeta';
import ClipPreview from './ClipPreview.vue';
import SongAutomationLane from './SongAutomationLane.vue';

/**
 * The song view: an arranger like in a DAW. Lanes run left to right on a timeline measured in bars,
 * and every clip on a lane is a track container playing for a while.
 *
 * Drag a container from the palette onto a lane to place it. Drag a clip to move it (also onto another lane),
 * drag its edges to change how long it plays, and use the cut tool to split it. Click the ruler to play from there.
 * Once a clip was selected (or a container clicked in the palette), pressing on empty lane space and dragging
 * paints that clip again and again along the lane.
 * Automation lanes below the clips draw a value of the master, a container or a track over the same timeline.
 */
const { bpm, containers, song, currentStep, isPlaying, playFrom, selectContainer, resolveTarget } = useJuicyLoops();
const confirm = useConfirm();
const router = useRouter();

const hasTracks = computed(() => containers.value.some((container) => container.tracks.length > 0));

/* ---- timeline geometry ---- */

const ZOOMS = [0.45, 0.7, 1.05];
const zoom = ref(1);
const stepRem = computed(() => ZOOMS[zoom.value]!);

/** Empty bars after the last clip, so there is always room to drop the next one. */
const TAIL_BARS = 8;
const MIN_BARS = 16;

const bars = computed(() => song.value.length / SONG_STEPS_PER_BAR);
const totalBars = computed(() => Math.max(MIN_BARS, bars.value + TAIL_BARS));
const totalSteps = computed(() => totalBars.value * SONG_STEPS_PER_BAR);

const timelineStyle = computed(() => ({
    '--jl-song-step': `${stepRem.value}rem`,
    '--jl-song-steps': totalSteps.value,
}));

/** Length of the song at the current tempo, as `m:ss`. */
const duration = computed(() => {
    const seconds = Math.round((bars.value * 4 * 60) / bpm.value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

const clipStyle = (clip: { start: number; length: number }) => ({
    left: `calc(${clip.start} * var(--jl-song-step))`,
    width: `calc(${clip.length} * var(--jl-song-step))`,
});

/** One hue per container, so clips of the same container look the same everywhere. */
const CLIP_HUES = [275, 315, 25, 95, 190, 345];
const containerHue = (id: string) => CLIP_HUES[Math.max(0, containers.value.findIndex((container) => container.id === id)) % CLIP_HUES.length]!;
const containerById = (id: string) => containers.value.find((container) => container.id === id);
const containerName = (id: string) => containerById(id)?.name ?? 'Removed container';

/** A new clip is as long as the container's longest loop. */
const defaultLength = (container: TrackContainer) => Math.max(STEP_COUNT, ...container.tracks.map((track) => track.length));

/* ---- tools and selection ---- */

type Tool = 'move' | 'cut';
const tool = ref<Tool>('move');
const TOOLS: readonly { key: Tool; label: string; icon: string; hint: string }[] = [
    { key: 'move', label: 'Move', icon: 'mdi:cursor-move', hint: 'Drag clips around, drag their edges to resize' },
    { key: 'cut', label: 'Cut', icon: 'mdi:content-cut', hint: 'Click a clip to split it at that point' },
];

const selectedId = ref<string | null>(null);

/** The last selected clip (or clicked container): what painting on empty lane space lays down. */
const template = ref<{ containerId: string; length: number } | null>(null);

watch(selectedId, (id) => {
    const clip = id ? song.value.getClip(id) : undefined;
    if (clip) {
        template.value = { containerId: clip.containerId, length: clip.length };
    }
});

const removeClip = (id: string) => {
    song.value.removeClip(id);
    if (selectedId.value === id) {
        selectedId.value = null;
    }
};

const duplicateClip = (id: string) => {
    const copy = song.value.duplicateClip(id);
    if (copy) {
        selectedId.value = copy.id;
    }
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

const editContainer = (containerId: string) => {
    selectContainer(containerId);
    router.push({ name: 'app.index' });
};

/* ---- lanes ---- */

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

const confirmRemoveLane = (event: MouseEvent, lane: SongLane) => {
    if (!lane.clips.length) {
        song.value.removeLane(lane.id);
        return;
    }
    confirm.require({
        target: event.currentTarget as HTMLElement,
        message: `Remove "${lane.name}" with its ${lane.clips.length} ${lane.clips.length === 1 ? 'clip' : 'clips'}?`,
        acceptLabel: 'Remove',
        rejectLabel: 'Keep',
        acceptProps: { severity: 'danger', size: 'small' },
        rejectProps: { text: true, size: 'small' },
        accept: () => song.value.removeLane(lane.id),
    });
};

/* ---- pointer interactions ---- */

type Drag =
    | { kind: 'new'; containerId: string; length: number }
    | { kind: 'move'; clipId: string; grab: number }
    | { kind: 'resize'; clipId: string; edge: 'start' | 'end' }
    | { kind: 'paint'; laneId: string; anchor: number; containerId: string; length: number; painted: string[] };

/** What the pointer is doing right now, null when idle. */
const drag = ref<Drag | null>(null);

/** The clip a drop would create or move, drawn where the pointer is. */
const ghost = ref<{ laneId: string; start: number; length: number; containerId: string; valid: boolean } | null>(null);
const isDragging = ref(false);

/** Where the cut tool would split, while hovering a clip. */
const cutMark = ref<{ clipId: string; step: number } | null>(null);

const scroller = ref<HTMLElement | null>(null);

const stepInBody = (body: HTMLElement, clientX: number) => {
    const rect = body.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * totalSteps.value;
};

/** The lane body under the pointer and the (unsnapped) step at that x. */
const locate = (event: PointerEvent): { lane: SongLane; step: number } | null => {
    const body = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-lane]');
    const lane = body ? song.value.getLane(body.dataset.lane!) : undefined;
    return body && lane ? { lane, step: stepInBody(body, event.clientX) } : null;
};

/** The step under the pointer on the lane of a clip, also when the pointer has left that lane. */
const stepAt = (event: PointerEvent, clipId: string): number => {
    const body = document.querySelector<HTMLElement>(`[data-lane="${song.value.laneOf(clipId)?.id}"]`);
    return body ? stepInBody(body, event.clientX) : 0;
};

const capture = (event: PointerEvent) => (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

const onPaletteDown = (event: PointerEvent, container: TrackContainer) => {
    if (event.button !== 0) {
        return;
    }
    capture(event);
    template.value = { containerId: container.id, length: defaultLength(container) };
    drag.value = { kind: 'new', containerId: container.id, length: defaultLength(container) };
    isDragging.value = true;
};

/** Pressing on empty lane space: with a template, start painting it; either way drop the selection. */
const onLaneDown = (event: PointerEvent, lane: SongLane) => {
    if (event.button !== 0 || event.target !== event.currentTarget) {
        return;
    }
    selectedId.value = null;
    if (tool.value !== 'move' || !template.value || !containerById(template.value.containerId)) {
        return;
    }
    capture(event);
    drag.value = { kind: 'paint', laneId: lane.id, anchor: snapStep(stepInBody(event.currentTarget as HTMLElement, event.clientX)), ...template.value, painted: [] };
};

/** Lays the template down from the anchor towards the pointer, one clip after another, only where the lane is free. */
const paintTo = (paint: Extract<Drag, { kind: 'paint' }>, pointerStep: number) => {
    const { length, anchor } = paint;
    const wanted: number[] = [];
    if (pointerStep >= anchor) {
        for (let start = anchor; start <= pointerStep; start += length) {
            wanted.push(start);
        }
    } else {
        for (let start = anchor - length; start + length > pointerStep && start >= 0; start -= length) {
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
        const exists = paint.painted.some((id) => song.value.getClip(id)?.start === start);
        if (!exists) {
            const clip = song.value.addClip(paint.laneId, paint.containerId, start, length);
            if (clip) {
                paint.painted.push(clip.id);
            }
        }
    }
    isDragging.value = paint.painted.length > 0;
};

const onClipDown = (event: PointerEvent, clip: SongClip) => {
    if (event.button !== 0) {
        return;
    }
    event.stopPropagation();
    selectedId.value = clip.id;

    if (tool.value === 'cut') {
        const right = song.value.splitClip(clip.id, stepAt(event, clip.id));
        if (right) {
            selectedId.value = right.id;
        }
        return;
    }

    capture(event);
    drag.value = { kind: 'move', clipId: clip.id, grab: stepAt(event, clip.id) - clip.start };
};

const onHandleDown = (event: PointerEvent, clip: SongClip, edge: 'start' | 'end') => {
    if (event.button !== 0 || tool.value === 'cut') {
        return;
    }
    event.stopPropagation();
    selectedId.value = clip.id;
    capture(event);
    drag.value = { kind: 'resize', clipId: clip.id, edge };
    isDragging.value = true;
};

const onPointerMove = (event: PointerEvent) => {
    const current = drag.value;
    if (!current) {
        if (tool.value === 'cut') {
            const clipEl = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-clip]');
            const clip = clipEl ? song.value.getClip(clipEl.dataset.clip!) : undefined;
            cutMark.value = clip ? { clipId: clip.id, step: snapStep(stepAt(event, clip.id)) } : null;
        }
        return;
    }

    if (current.kind === 'paint') {
        const body = document.querySelector<HTMLElement>(`[data-lane="${current.laneId}"]`);
        if (body) {
            paintTo(current, stepInBody(body, event.clientX));
        }
        return;
    }

    if (current.kind === 'resize') {
        const step = stepAt(event, current.clipId);
        if (current.edge === 'end') {
            song.value.setClipEnd(current.clipId, step);
        } else {
            song.value.setClipStart(current.clipId, step);
        }
        return;
    }

    const target = locate(event);
    if (!target) {
        ghost.value = null;
        return;
    }

    if (current.kind === 'move') {
        const clip = song.value.getClip(current.clipId);
        if (!clip) {
            return;
        }
        isDragging.value = true;
        const start = snapStep(target.step - current.grab);
        ghost.value = { laneId: target.lane.id, start, length: clip.length, containerId: clip.containerId, valid: song.value.isFree(target.lane.id, start, clip.length, clip.id) };
        return;
    }

    const start = snapStep(target.step);
    ghost.value = { laneId: target.lane.id, start, length: current.length, containerId: current.containerId, valid: song.value.isFree(target.lane.id, start, current.length) };
};

const onPointerUp = () => {
    const current = drag.value;
    if (current && ghost.value?.valid) {
        if (current.kind === 'new') {
            const clip = song.value.addClip(ghost.value.laneId, current.containerId, ghost.value.start, current.length);
            selectedId.value = clip?.id ?? null;
        } else if (current.kind === 'move') {
            song.value.moveClip(current.clipId, ghost.value.start, ghost.value.laneId);
        }
    }
    if (current?.kind === 'paint' && current.painted.length) {
        selectedId.value = current.painted[current.painted.length - 1]!;
    }
    cancelDrag();
};

const cancelDrag = () => {
    drag.value = null;
    ghost.value = null;
    isDragging.value = false;
};

const isLifted = (clip: SongClip) => !!ghost.value && drag.value?.kind === 'move' && drag.value.clipId === clip.id;

/** Clicking the ruler plays from that beat. */
const onRulerClick = (event: MouseEvent) => {
    playFrom(snapStep(stepInBody(event.currentTarget as HTMLElement, event.clientX)));
};

const isTypingTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return !!element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable);
};

const onKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) {
        return;
    }
    if (event.key === 'Escape') {
        cancelDrag();
        selectedId.value = null;
        return;
    }
    const clip = selectedId.value ? song.value.getClip(selectedId.value) : undefined;
    if (!clip) {
        return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeClip(clip.id);
    } else if (event.key === 'd' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        duplicateClip(clip.id);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const delta = (event.shiftKey ? SONG_STEPS_PER_BAR : SONG_SNAP) * (event.key === 'ArrowLeft' ? -1 : 1);
        song.value.moveClip(clip.id, clip.start + delta);
    }
};

/* The playhead stays in view while the song plays. */
watch(currentStep, (step) => {
    const element = scroller.value;
    if (!isPlaying.value || !element) {
        return;
    }
    const headWidth = element.querySelector<HTMLElement>('.arr-corner')?.offsetWidth ?? 0;
    const stepPx = (element.querySelector<HTMLElement>('[data-lane]')?.offsetWidth ?? 0) / totalSteps.value;
    const x = headWidth + step * stepPx;
    if (x < element.scrollLeft + headWidth || x > element.scrollLeft + element.clientWidth - 24) {
        element.scrollTo({ left: Math.max(0, x - headWidth - 24) });
    }
});

onMounted(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerup', onPointerUp);
});
onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointerup', onPointerUp);
});
</script>

<template>
    <div class="page">
        <div v-if="!hasTracks" class="hero">
            <div>
                <h2 class="hero-title">Nothing to arrange yet</h2>
                <p class="hero-text">A song is built from track containers. Put a few tracks into one first, then come back and lay it out.</p>
            </div>
            <RouterLink :to="{ name: 'app.index' }" class="playbtn playbtn--wide">
                <Icon icon="mdi:dots-grid" class="w-5 h-5" />
                <span>Go to tracks</span>
            </RouterLink>
        </div>

        <template v-else>
            <div class="toolbar">
                <div class="toolbar-title">
                    <h2>Song</h2>
                    <span class="toolbar-meta">
                        <b>{{ bars }}</b> {{ bars === 1 ? 'bar' : 'bars' }} <i>·</i> <b>{{ duration }}</b> at <b>{{ bpm }}</b> BPM <i>·</i> <b>{{ song.lanes.length }}</b>
                        {{ song.lanes.length === 1 ? 'lane' : 'lanes' }}
                    </span>
                </div>
                <div class="flex-1"></div>
                <div class="viewswitch" role="radiogroup" aria-label="Tool">
                    <button
                        v-for="item in TOOLS"
                        :key="item.key"
                        type="button"
                        class="viewswitch-item"
                        role="radio"
                        :aria-checked="tool === item.key"
                        :data-active="tool === item.key"
                        v-tooltip.bottom="{ value: item.hint, showDelay: 500 }"
                        @click="tool = item.key"
                    >
                        <Icon :icon="item.icon" class="w-4 h-4" />
                        <span>{{ item.label }}</span>
                    </button>
                </div>
                <div class="tempo" aria-label="Zoom">
                    <button type="button" class="iconbtn" aria-label="Zoom out" v-tooltip.bottom="'Zoom out'" :disabled="zoom === 0" @click="zoom--">
                        <Icon icon="mdi:magnify-minus-outline" class="w-4 h-4" />
                    </button>
                    <button type="button" class="iconbtn" aria-label="Zoom in" v-tooltip.bottom="'Zoom in'" :disabled="zoom === ZOOMS.length - 1" @click="zoom++">
                        <Icon icon="mdi:magnify-plus-outline" class="w-4 h-4" />
                    </button>
                </div>
                <button type="button" class="chip" @click="song.addLane()">
                    <Icon icon="mdi:plus" class="w-4 h-4" />
                    <span>Add lane</span>
                </button>
                <button type="button" class="chip" v-tooltip.bottom="'Draw a value of the master, a container or a track over the song'" @click="addAutomation">
                    <Icon icon="mdi:chart-bell-curve-cumulative" class="w-4 h-4" />
                    <span>Automate</span>
                </button>
            </div>

            <div class="palette">
                <span class="eyebrow">Containers</span>
                <div
                    v-for="container in containers"
                    :key="container.id"
                    class="palette-item"
                    :style="{ '--jl-clip-hue': containerHue(container.id) }"
                    :data-empty="!container.tracks.length"
                    role="button"
                    tabindex="0"
                    :aria-label="`Drag ${container.name} onto a lane`"
                    v-tooltip.bottom="{ value: container.tracks.length ? 'Drag onto a lane' : 'No tracks yet', showDelay: 500 }"
                    @pointerdown="container.tracks.length && onPaletteDown($event, container)"
                    @pointermove="onPointerMove"
                    @pointercancel="cancelDrag"
                    @dblclick="editContainer(container.id)"
                >
                    <span class="palette-swatch"></span>
                    <span class="palette-name">{{ container.name }}</span>
                    <span class="ctab-dots" aria-hidden="true">
                        <span v-for="track in container.tracks.slice(0, 6)" :key="track.id" class="ctab-dot" :style="{ background: TRACK_META[track.type].accent }"></span>
                    </span>
                    <span class="ctab-count">{{ defaultLength(container) / SONG_STEPS_PER_BAR }} bars</span>
                </div>
                <span class="palette-hint">{{
                    template ? 'Drag onto a lane, or press on empty lane space and drag to repeat the last clip.' : 'Drag a container onto a lane. Double-click one to edit its tracks.'
                }}</span>
            </div>

            <div
                ref="scroller"
                class="arranger"
                :class="{ 'arranger--dragging': isDragging, 'arranger--cut': tool === 'cut', 'arranger--paint': tool === 'move' && !!template }"
                :style="timelineStyle"
            >
                <div class="arr-inner">
                    <div class="arr-row arr-row--ruler">
                        <div class="arr-corner"><span class="eyebrow">Lane</span></div>
                        <div class="arr-ruler" v-tooltip.bottom="{ value: 'Click to play from here', showDelay: 800 }" @click="onRulerClick">
                            <span v-for="bar in totalBars" :key="bar" class="arr-bar" :data-inside="bar <= bars">{{ bar }}</span>
                        </div>
                    </div>

                    <div v-for="lane in song.lanes" :key="lane.id" class="arr-row" :class="{ 'arr-row--muted': lane.isMuted }">
                        <div class="arr-head">
                            <div class="arr-head-title">
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
                                <span v-else class="arr-head-name" @dblclick="startRenameLane(lane)">{{ lane.name }}</span>
                                <span class="ctab-count">{{ lane.clips.length }}</span>
                            </div>
                            <div class="arr-head-tools">
                                <button
                                    type="button"
                                    class="iconbtn iconbtn--tiny"
                                    :data-active="lane.isMuted"
                                    :aria-pressed="lane.isMuted"
                                    :aria-label="lane.isMuted ? 'Unmute lane' : 'Mute lane'"
                                    v-tooltip.bottom="lane.isMuted ? 'Unmute lane' : 'Mute lane'"
                                    @click="lane.isMuted = !lane.isMuted"
                                >
                                    <Icon :icon="lane.isMuted ? 'mdi:volume-off' : 'mdi:volume-high'" class="w-3.5 h-3.5" />
                                </button>
                                <button type="button" class="iconbtn iconbtn--tiny" aria-label="Rename lane" v-tooltip.bottom="'Rename'" @click="startRenameLane(lane)">
                                    <Icon icon="mdi:pencil-outline" class="w-3.5 h-3.5" />
                                </button>
                                <button type="button" class="iconbtn iconbtn--tiny" aria-label="Move lane up" :disabled="lane === song.lanes[0]" @click="song.moveLane(lane.id, -1)">
                                    <Icon icon="mdi:chevron-up" class="w-3.5 h-3.5" />
                                </button>
                                <button
                                    type="button"
                                    class="iconbtn iconbtn--tiny"
                                    aria-label="Move lane down"
                                    :disabled="lane === song.lanes[song.lanes.length - 1]"
                                    @click="song.moveLane(lane.id, 1)"
                                >
                                    <Icon icon="mdi:chevron-down" class="w-3.5 h-3.5" />
                                </button>
                                <button
                                    type="button"
                                    class="iconbtn iconbtn--tiny iconbtn--danger"
                                    aria-label="Remove lane"
                                    :disabled="song.lanes.length === 1"
                                    v-tooltip.bottom="song.lanes.length === 1 ? 'The last lane stays' : 'Remove lane'"
                                    @click="confirmRemoveLane($event, lane)"
                                >
                                    <Icon icon="mdi:trash-can-outline" class="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>

                        <div class="arr-lane" :data-lane="lane.id" @pointermove="onPointerMove" @pointerleave="cutMark = null" @pointerdown="onLaneDown($event, lane)" @pointercancel="cancelDrag">
                            <div
                                v-for="clip in lane.clips"
                                :key="clip.id"
                                class="clip"
                                :class="{ 'clip--selected': selectedId === clip.id, 'clip--lifted': isLifted(clip) }"
                                :style="{ ...clipStyle(clip), '--jl-clip-hue': containerHue(clip.containerId) }"
                                :data-clip="clip.id"
                                role="button"
                                tabindex="0"
                                :aria-label="`${containerName(clip.containerId)}, bar ${clip.start / SONG_STEPS_PER_BAR + 1}, ${clip.length / SONG_STEPS_PER_BAR} bars`"
                                @pointerdown="onClipDown($event, clip)"
                                @pointermove="onPointerMove"
                                @pointercancel="cancelDrag"
                                @keydown.enter.self="selectedId = clip.id"
                                @dblclick="editContainer(clip.containerId)"
                            >
                                <span class="note-handle note-handle--start" title="Drag to change the start" @pointerdown="onHandleDown($event, clip, 'start')"></span>
                                <span class="clip-title">{{ containerName(clip.containerId) }}</span>
                                <ClipPreview v-if="containerById(clip.containerId)" :container="containerById(clip.containerId)!" :offset="clip.offset" :length="clip.length" />
                                <span class="note-handle note-handle--end" title="Drag to change the length" @pointerdown="onHandleDown($event, clip, 'end')"></span>
                                <span v-if="cutMark?.clipId === clip.id" class="clip-cut" :style="{ left: `calc(${cutMark.step - clip.start} * var(--jl-song-step))` }"></span>
                                <span v-if="selectedId === clip.id && tool === 'move'" class="clip-tools" @pointerdown.stop>
                                    <button type="button" class="iconbtn iconbtn--tiny" aria-label="Duplicate clip" v-tooltip.top="'Duplicate (Ctrl+D)'" @click.stop="duplicateClip(clip.id)">
                                        <Icon icon="mdi:content-copy" class="w-3 h-3" />
                                    </button>
                                    <button type="button" class="iconbtn iconbtn--tiny iconbtn--danger" aria-label="Remove clip" v-tooltip.top="'Remove (Delete)'" @click.stop="removeClip(clip.id)">
                                        <Icon icon="mdi:close" class="w-3.5 h-3.5" />
                                    </button>
                                </span>
                            </div>

                            <div
                                v-if="ghost && ghost.laneId === lane.id"
                                class="clip clip--ghost"
                                :data-valid="ghost.valid"
                                :style="{ ...clipStyle(ghost), '--jl-clip-hue': containerHue(ghost.containerId) }"
                                aria-hidden="true"
                            >
                                <span class="clip-title">{{ containerName(ghost.containerId) }}</span>
                            </div>
                        </div>
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

                    <div v-if="song.isEmpty" class="arr-empty">
                        <span class="song-hint">Drag a container from above onto a lane to start the song.</span>
                    </div>

                    <div v-if="isPlaying" class="arr-playhead" :style="{ left: `calc(var(--jl-lane-head) + ${currentStep} * var(--jl-song-step))` }" aria-hidden="true"></div>
                </div>
            </div>
        </template>
    </div>
</template>
