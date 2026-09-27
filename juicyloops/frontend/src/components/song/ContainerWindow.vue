<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import { MIN_WINDOW_WIDTH, useContainerWindows, type ContainerWindowState } from '@/composables/useContainerWindows';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import ContainerTracks from '../tracks/ContainerTracks.vue';

/**
 * One container's tracks in a floating window over the song. Drag the title bar to move it, an edge or a corner to
 * resize it, double-click the title bar to fill the song view with it. Everything in it works as in the track view,
 * and while the song plays the playhead shows where the song is inside this container.
 */
const props = defineProps<{
    state: ContainerWindowState;
    container: TrackContainer;
    hue: number;
    /** Where the song plays this container right now, null while no clip of it sounds. */
    step: number | null;
    /** The size of the song view the window lives in. */
    area: { width: number; height: number };
}>();

const { renameContainer } = useJuicyLoops();
const { focus, close, fit, toggleMaximize } = useContainerWindows();
const { isMixerOpen, toggleMixer } = useWorkspace();
const router = useRouter();

const style = computed(() =>
    props.state.isMaximized
        ? { zIndex: props.state.z, '--jl-clip-hue': props.hue }
        : {
              zIndex: props.state.z,
              left: `${props.state.x}px`,
              top: `${props.state.y}px`,
              width: `${props.state.width}px`,
              height: `${props.state.height}px`,
              '--jl-clip-hue': props.hue,
          },
);

/* ---- moving and resizing ---- */

type Edge = 'move' | 'e' | 'w' | 's' | 'se' | 'sw';

const drag = ref<{ edge: Edge; pointerId: number; startX: number; startY: number; from: Pick<ContainerWindowState, 'x' | 'y' | 'width' | 'height'> } | null>(null);

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
    fit(state, props.area);
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
        toggleMaximize(props.container.id);
    }
};

const EDGES: readonly Exclude<Edge, 'move'>[] = ['e', 'w', 's', 'se', 'sw'];

/* ---- renaming ---- */

const isRenaming = ref(false);
const draft = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

const startRename = async () => {
    draft.value = props.container.name;
    isRenaming.value = true;
    await nextTick();
    nameInput.value?.focus();
    nameInput.value?.select();
};

const commitRename = () => {
    if (isRenaming.value) {
        renameContainer(props.container.id, draft.value);
    }
    isRenaming.value = false;
};

/* ---- title bar buttons ---- */

/** The mixer's container channel shows the current container, which this window's is as soon as it is clicked. */
const toggleChannel = () => {
    focus(props.container.id);
    toggleMixer();
};

const openInTrackView = () => {
    focus(props.container.id);
    void router.push({ name: 'app.index' });
};

const trackCount = computed(() => `${props.container.tracks.length} ${props.container.tracks.length === 1 ? 'track' : 'tracks'}`);
</script>

<template>
    <section
        class="cwin"
        :class="{ 'cwin--maximized': props.state.isMaximized, 'cwin--dragging': drag }"
        :style="style"
        role="dialog"
        :aria-label="`${props.container.name}: tracks`"
        @pointerdown.capture="focus(props.container.id)"
    >
        <header
            class="cwin-bar"
            @pointerdown="onBarDown"
            @pointermove="onDragMove"
            @pointerup="endDrag"
            @pointercancel="endDrag"
            @dblclick="onBarDoubleClick"
        >
            <span class="cwin-swatch" aria-hidden="true"></span>
            <input
                v-if="isRenaming"
                ref="nameInput"
                v-model="draft"
                class="cwin-input"
                aria-label="Container name"
                @keydown.enter="commitRename"
                @keydown.esc="isRenaming = false"
                @blur="commitRename"
            />
            <span
                v-else
                class="cwin-name"
                v-tooltip.bottom="{ value: 'Double-click to rename', showDelay: 600 }"
                @dblclick.stop="startRename"
                >{{ props.container.name }}</span
            >
            <span class="cwin-meta">
                {{ trackCount }}
                <span v-if="props.step !== null" class="cwin-live" v-tooltip.bottom="'Playing in the song right now'"><i></i>live</span>
            </span>
            <span class="flex-1"></span>

            <button
                type="button"
                class="iconbtn iconbtn--tiny"
                :data-active="isMixerOpen"
                aria-label="Container channel"
                v-tooltip.bottom="'Level, pan and effects for the whole container, in the mixer'"
                @click="toggleChannel"
            >
                <Icon icon="mdi:tune-vertical" class="w-3.5 h-3.5" />
            </button>
            <button type="button" class="iconbtn iconbtn--tiny" aria-label="Open in the track view" v-tooltip.bottom="'Open in the track view (loops the container)'" @click="openInTrackView">
                <Icon icon="mdi:dots-grid" class="w-3.5 h-3.5" />
            </button>
            <button
                type="button"
                class="iconbtn iconbtn--tiny"
                :aria-label="props.state.isMaximized ? 'Restore window' : 'Maximize window'"
                v-tooltip.bottom="props.state.isMaximized ? 'Restore' : 'Fill the song view'"
                @click="toggleMaximize(props.container.id)"
            >
                <Icon :icon="props.state.isMaximized ? 'mdi:window-restore' : 'mdi:window-maximize'" class="w-3.5 h-3.5" />
            </button>
            <button type="button" class="iconbtn iconbtn--tiny" aria-label="Close window" v-tooltip.bottom="'Close'" @click="close(props.container.id)">
                <Icon icon="mdi:close" class="w-3.5 h-3.5" />
            </button>
        </header>

        <div class="cwin-body">
            <ContainerTracks :container="props.container" :step="props.step" compact />
        </div>

        <template v-if="!props.state.isMaximized">
            <span
                v-for="edge in EDGES"
                :key="edge"
                class="cwin-edge"
                :class="`cwin-edge--${edge}`"
                aria-hidden="true"
                @pointerdown="startDrag($event, edge)"
                @pointermove="onDragMove"
                @pointerup="endDrag"
                @pointercancel="endDrag"
            ></span>
        </template>
    </section>
</template>
