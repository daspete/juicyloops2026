<script setup lang="ts">
import { Drawer, useConfirm, useToast } from 'primevue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { MAX_BPM, MIN_BPM, useJuicyLoops } from '@/composables/useJuicyLoops';
import { useHistory } from '@/composables/useHistory';
import { useHoldRepeat } from '@/composables/useHoldRepeat';
import { useSession, type SessionResult } from '@/composables/useSession';
import { useTheme } from '@/composables/useTheme';
import { useWorkspace, type WorkspaceMode } from '@/composables/useWorkspace';
import { positionLabel } from './tracks/steps';
import DetailPanel from './detail/DetailPanel.vue';
import GiscusLoader from './GiscusLoader.vue';
import JuicyLogo from './JuicyLogo.vue';
import MixPanel from './mix/MixPanel.vue';
import { TRACK_META } from './tracks/trackMeta';

/**
 * The application shell: transport, view switcher, the mode switch and the frame around the editors.
 * The track editor and the song editor are routes rendered into the main area; the mixer docks to its right,
 * the detail panel below it.
 */
const { engine, bpm, setBpm, tapTempo, currentTick, currentStep, isPlaying, togglePlay, setMode: setPlaybackMode, containers, song } = useJuicyLoops();
const { theme, toggleTheme } = useTheme();
const { mode, isPro, setMode, isMixerOpen, toggleMixer, isDetailOpen, toggleDetail } = useWorkspace();
const { canUndo, canRedo, commit, undo, redo } = useHistory();
const session = useSession();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const confirm = useConfirm();

/* What you see is what you hear: the song view plays the arrangement, the track view loops every track. */
const isSongView = computed(() => route.name === 'app.song');
watch(isSongView, (value) => setPlaybackMode(value ? 'song' : 'loop'), { immediate: true });

/* The track panel belongs to the track view: the song view hides it (and its chip) and shows it again on the way back. */
/* Quick mode has no song view: leaving Pro while arranging brings you back to the tracks. */
watch(
    [isPro, isSongView],
    ([pro, song]) => {
        if (!pro && song) {
            router.replace({ name: 'app.index' });
        }
    },
    { immediate: true },
);

const VIEWS = [
    { name: 'app.index', label: 'Tracks', icon: 'mdi:dots-grid', hint: 'Build containers of loops' },
    { name: 'app.song', label: 'Song', icon: 'mdi:view-sequential-outline', hint: 'Arrange the containers' },
] as const;

const MODES = [
    { key: 'quick', label: 'Quick', icon: 'mdi:lightning-bolt', hint: 'Just the tracks: add, paint, tweak', blurb: 'Just the tracks. Add one, paint steps, shape its sound.' },
    { key: 'pro', label: 'Pro', icon: 'mdi:tune-vertical-variant', hint: 'Containers, song arranger, mixer and automation', blurb: 'The whole studio: containers, song arranger, mixer and automation.' },
] as const;

/** What the status bar suggests, depending on where you are. */
const statusHint = computed(() => {
    if (isSongView.value) {
        return 'Drag a container onto a lane · Drag clip edges to resize · Click an automation lane to draw';
    }
    return isPro.value
        ? 'Tap a pad to add a step · Drag across pads to paint · Automate on a track head opens its lanes'
        : 'Tap a pad to add a step · Drag across pads to paint · Switch to Pro for containers, the song and the mixer';
});

const isInitialized = ref(false);
const isDiscussionsOpen = ref(false);

/** The first click, which the browser needs before it allows sound, also picks the mode. */
const start = async (chosen: WorkspaceMode) => {
    setMode(chosen);
    await engine.initialize();
    isInitialized.value = true;
};

const position = computed(() => positionLabel(isSongView.value ? currentStep.value : currentTick.value));

/* ---- the session file ---- */

const onSessionNameChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    session.setName(input.value);
    input.value = session.name.value;
};

const report = (result: SessionResult, done: string) => {
    if (result.ok) {
        toast.add({ severity: 'success', summary: done, detail: result.fileName, life: 2500 });
    } else if ('error' in result) {
        toast.add({ severity: 'error', summary: 'Sorry', detail: result.error, life: 6000 });
    }
};

const save = async (as = false) => report(await session.save({ as }), 'Saved');

/** Opens a file, after asking when the session has changes that would be lost. */
const open = (file?: File) => {
    const go = async () => report(file ? await session.openFile(file) : await session.open(), 'Opened');
    if (!session.isDirty.value) {
        void go();
        return;
    }
    confirm.require({
        group: 'confirmdialog',
        header: 'Open a file',
        message: `"${session.name.value}" has unsaved changes. Opening a file throws them away.`,
        acceptLabel: 'Open anyway',
        rejectLabel: 'Keep working',
        acceptProps: { severity: 'danger', size: 'small' },
        rejectProps: { text: true, size: 'small' },
        accept: () => void go(),
    });
};

/* A session file dropped anywhere on the app opens it. */
const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
    }
};

const onDrop = (event: DragEvent) => {
    const file = event.dataTransfer?.files[0];
    if (file && session.isSessionFile(file)) {
        event.preventDefault();
        event.stopPropagation();
        open(file);
    }
};

const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (session.isDirty.value) {
        event.preventDefault();
    }
};

watch(
    [session.name, session.isDirty],
    ([name, dirty]) => {
        document.title = `${dirty ? '• ' : ''}${name} · Juicy Loops`;
    },
    { immediate: true },
);

const onBpmInput = (event: Event) => setBpm(Number((event.target as HTMLInputElement).value));

/*
 * Dragging on the tempo field changes it like a number box in a DAW: up is faster, down is slower.
 * A plain click (no movement) still focuses the field for typing.
 */
const DRAG_PX_PER_BPM = 3;
const DRAG_FINE_FACTOR = 4;
const DRAG_THRESHOLD_PX = 3;

const drag = { pointerId: -1, startY: 0, startBpm: 0, active: false };
const isDraggingBpm = ref(false);

const onBpmPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
        return;
    }
    drag.pointerId = event.pointerId;
    drag.startY = event.clientY;
    drag.startBpm = bpm.value;
    drag.active = false;
};

const onBpmPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== drag.pointerId) {
        return;
    }
    const input = event.currentTarget as HTMLInputElement;
    const dy = drag.startY - event.clientY;

    if (!drag.active) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) {
            return;
        }
        drag.active = true;
        isDraggingBpm.value = true;
        input.blur();
        input.setPointerCapture(event.pointerId);
    }

    event.preventDefault();
    const pxPerBpm = DRAG_PX_PER_BPM * (event.shiftKey ? DRAG_FINE_FACTOR : 1);
    setBpm(drag.startBpm + Math.round(dy / pxPerBpm));
};

const onBpmPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== drag.pointerId) {
        return;
    }
    if (drag.active) {
        (event.currentTarget as HTMLInputElement).releasePointerCapture(event.pointerId);
    }
    drag.pointerId = -1;
    drag.active = false;
    isDraggingBpm.value = false;
};

/* Holding the tempo buttons keeps stepping the value. */
const holdSlower = useHoldRepeat(() => setBpm(bpm.value - 1));
const holdFaster = useHoldRepeat(() => setBpm(bpm.value + 1));

const isTypingTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return !!element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable);
};

/**
 * Space plays and stops, Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo, Ctrl+S saves (Ctrl+Shift+S asks where)
 * and Ctrl+O opens, like in every DAW. Saving and opening work from inside a text field too.
 */
const onKeyDown = (event: KeyboardEvent) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.altKey && (event.key === 's' || event.key === 'S' || event.key === 'o' || event.key === 'O')) {
        event.preventDefault();
        if (event.key === 's' || event.key === 'S') {
            void save(event.shiftKey);
        } else if (!event.shiftKey) {
            open();
        }
        return;
    }
    if (isTypingTarget(event.target)) {
        return;
    }
    if (modifier && (event.key === 'z' || event.key === 'Z' || event.key === 'y')) {
        event.preventDefault();
        if (event.key === 'y' || event.shiftKey) {
            redo();
        } else {
            undo();
        }
        return;
    }
    if (event.code === 'Space' && isInitialized.value) {
        event.preventDefault();
        togglePlay();
    }
};

/*
 * History: every gesture ends in one of these events, so a snapshot is taken right after it, and once more a
 * moment later for changes that land asynchronously (a decoded sample, a duplicated track). Changes that arrive
 * with no gesture at all (a finished recording) are caught by the watcher on the model, once the pointer is up.
 */
const HISTORY_EVENTS = ['pointerup', 'keyup', 'change', 'drop', 'dragend'] as const;
const LATE_COMMIT_MS = 500;
let lateCommit: ReturnType<typeof setTimeout> | null = null;
let isPointerDown = false;

const scheduleCommit = () => {
    queueMicrotask(commit);
    if (lateCommit) {
        clearTimeout(lateCommit);
    }
    lateCommit = setTimeout(commit, LATE_COMMIT_MS);
};

const onPointerDown = () => (isPointerDown = true);
const onPointerUp = () => (isPointerDown = false);

watch(
    [containers, song],
    () => {
        if (!isPointerDown) {
            scheduleCommit();
        }
    },
    { deep: true, flush: 'post' },
);

onMounted(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    HISTORY_EVENTS.forEach((type) => window.addEventListener(type, scheduleCommit, true));
});
onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('drop', onDrop, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    HISTORY_EVENTS.forEach((type) => window.removeEventListener(type, scheduleCommit, true));
});
</script>

<template>
    <div class="app">
        <header class="transportbar">
            <div class="transportbar-left">
                <div class="logo">
                    <JuicyLogo />
                </div>

                <div class="filebar" :data-busy="session.isBusy.value">
                    <input
                        class="filebar-name"
                        type="text"
                        :value="session.name.value"
                        maxlength="80"
                        spellcheck="false"
                        aria-label="Session name"
                        v-tooltip.bottom="{ value: 'The name of this session, and of its file', showDelay: 800 }"
                        @change="onSessionNameChange"
                        @keydown.enter="($event.target as HTMLInputElement).blur()"
                    />
                    <span class="filebar-dirty" :data-dirty="session.isDirty.value" aria-hidden="true"></span>
                    <span class="vrule"></span>
                    <button type="button" class="iconbtn" :disabled="session.isBusy.value" aria-label="Open a file" v-tooltip.bottom="'Open a file (Ctrl+O)'" @click="open()">
                        <Icon icon="mdi:folder-open-outline" class="w-5 h-5" />
                    </button>
                    <button
                        type="button"
                        class="iconbtn"
                        :disabled="session.isBusy.value"
                        aria-label="Save"
                        v-tooltip.bottom="session.hasFile.value ? `Save to ${session.name.value} (Ctrl+S)` : 'Save as a file, with all samples and recordings (Ctrl+S)'"
                        @click="save()"
                    >
                        <Icon icon="mdi:content-save-outline" class="w-5 h-5" />
                    </button>
                    <button
                        v-if="session.hasFile.value"
                        type="button"
                        class="iconbtn"
                        :disabled="session.isBusy.value"
                        aria-label="Save as"
                        v-tooltip.bottom="'Save as a new file (Ctrl+Shift+S)'"
                        @click="save(true)"
                    >
                        <Icon icon="mdi:content-save-edit-outline" class="w-5 h-5" />
                    </button>
                </div>

                <nav v-if="isPro" class="viewswitch" aria-label="Editor">
                    <RouterLink
                        v-for="view in VIEWS"
                        :key="view.name"
                        :to="{ name: view.name }"
                        class="viewswitch-item"
                        :data-active="route.name === view.name"
                        v-tooltip.bottom="{ value: view.hint, showDelay: 600 }"
                    >
                        <Icon :icon="view.icon" class="w-4 h-4" />
                        <span>{{ view.label }}</span>
                        <span v-if="view.name === 'app.index' && containers.length > 1" class="viewswitch-count">{{ containers.length }}</span>
                    </RouterLink>
                </nav>
            </div>

            <div class="transport">
                <button
                    type="button"
                    class="playbtn"
                    :data-playing="isPlaying"
                    v-tooltip.bottom="isPlaying ? 'Stop (space)' : 'Play (space)'"
                    :aria-label="isPlaying ? 'Stop' : 'Play'"
                    @click="togglePlay"
                >
                    <Icon :icon="isPlaying ? 'material-symbols:stop-rounded' : 'material-symbols:play-arrow-rounded'" class="w-7 h-7" />
                </button>

                <div class="readout" :data-playing="isPlaying" aria-live="off" v-tooltip.bottom="{ value: 'Bar . beat . step', showDelay: 800 }">
                    <span class="readout-dot"></span>
                    <span class="readout-value">{{ position }}</span>
                    <span class="readout-unit">{{ isSongView ? 'song' : 'loop' }}</span>
                </div>

                <div class="tempo">
                    <button type="button" class="iconbtn" aria-label="Slower" v-tooltip.bottom="{ value: 'Hold to keep going', showDelay: 800 }" v-on="holdSlower">
                        <Icon icon="mdi:minus" class="w-4 h-4" />
                    </button>
                    <input
                        class="bpm-input"
                        :class="{ 'bpm-input--dragging': isDraggingBpm }"
                        type="number"
                        :min="MIN_BPM"
                        :max="MAX_BPM"
                        :value="bpm"
                        aria-label="Tempo in beats per minute"
                        v-tooltip.bottom="{ value: 'Drag up or down, or click to type. Hold Shift for fine steps.', showDelay: 800 }"
                        @change="onBpmInput"
                        @pointerdown="onBpmPointerDown"
                        @pointermove="onBpmPointerMove"
                        @pointerup="onBpmPointerUp"
                        @pointercancel="onBpmPointerUp"
                    />
                    <span class="tempo-unit">BPM</span>
                    <button type="button" class="iconbtn" aria-label="Faster" v-tooltip.bottom="{ value: 'Hold to keep going', showDelay: 800 }" v-on="holdFaster">
                        <Icon icon="mdi:plus" class="w-4 h-4" />
                    </button>
                    <span class="vrule"></span>
                    <button type="button" class="iconbtn" v-tooltip.bottom="'Tap along to set the tempo'" @click="tapTempo">Tap</button>
                </div>

                <div class="history">
                    <button type="button" class="iconbtn" :disabled="!canUndo" aria-label="Undo" v-tooltip.bottom="'Undo (Ctrl+Z)'" @click="undo">
                        <Icon icon="mdi:undo" class="w-5 h-5" />
                    </button>
                    <button type="button" class="iconbtn" :disabled="!canRedo" aria-label="Redo" v-tooltip.bottom="'Redo (Ctrl+Shift+Z)'" @click="redo">
                        <Icon icon="mdi:redo" class="w-5 h-5" />
                    </button>
                </div>
            </div>

            <div class="transportbar-right">
                <div class="modeswitch" role="radiogroup" aria-label="Mode">
                    <button
                        v-for="item in MODES"
                        :key="item.key"
                        type="button"
                        class="modeswitch-item"
                        role="radio"
                        :aria-checked="mode === item.key"
                        :data-active="mode === item.key"
                        :data-mode="item.key"
                        v-tooltip.bottom="{ value: item.hint, showDelay: 400 }"
                        @click="setMode(item.key)"
                    >
                        <Icon :icon="item.icon" class="w-4 h-4" />
                        <span>{{ item.label }}</span>
                    </button>
                </div>
                <button
                    v-if="!isSongView"
                    type="button"
                    class="chip"
                    :data-active="isDetailOpen"
                    :aria-pressed="isDetailOpen"
                    v-tooltip.bottom="'Track panel: sound, pattern tools and effects of the selected track'"
                    @click="toggleDetail"
                >
                    <Icon icon="mdi:tune-variant" class="w-4 h-4" />
                    <span>Tweak</span>
                </button>
                <button
                    v-if="isPro"
                    type="button"
                    class="chip"
                    :data-active="isMixerOpen"
                    :aria-pressed="isMixerOpen"
                    v-tooltip.bottom="'Mixer: the container channel and the master, with their effects'"
                    @click="toggleMixer"
                >
                    <Icon icon="mdi:tune-vertical" class="w-4 h-4" />
                    <span>Mixer</span>
                </button>
                <span class="vrule"></span>
                <button
                    type="button"
                    class="iconbtn"
                    :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
                    v-tooltip.bottom="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
                    @click="toggleTheme"
                >
                    <Icon :icon="theme === 'dark' ? 'ph:sun' : 'ph:moon'" class="w-5 h-5" />
                </button>
                <button type="button" class="iconbtn" aria-label="Questions and feedback" v-tooltip.bottom="'Questions and feedback'" @click="isDiscussionsOpen = true">
                    <Icon icon="ph:chats" class="w-5 h-5" />
                </button>
            </div>
        </header>

        <div class="stage">
            <DetailPanel v-if="isDetailOpen && !isSongView" />
            <main class="workspace">
                <Suspense>
                    <RouterView v-slot="{ Component }">
                        <component :is="Component" />
                    </RouterView>
                </Suspense>
            </main>
            <MixPanel v-if="isPro && isMixerOpen" />
        </div>

        <footer class="statusbar">
            <span class="statusbar-hint">{{ statusHint }}</span>
            <span class="statusbar-key"><kbd>Space</kbd> play / stop</span>
            <span class="statusbar-key"><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</span>
            <span class="statusbar-key"><kbd>Ctrl</kbd>+<kbd>S</kbd> save</span>
            <span class="flex-1"></span>
            <span class="statusbar-credit">
                Made with ❤️ in Vienna by <a href="https://daspete.at" target="_blank" rel="noopener noreferrer">Pete</a>
            </span>
        </footer>
    </div>

    <div v-if="!isInitialized" class="welcome">
        <div class="welcome-card">
            <div class="welcome-logo">
                <JuicyLogo />
            </div>
            <h1 class="welcome-title">Make a loop<br />in a minute.</h1>
            <p class="welcome-text">Add a track, tap some steps, press play. Pick how much studio you want; you can switch any time from the top bar.</p>
            <div class="welcome-juice" aria-hidden="true">
                <span v-for="(meta, type) in TRACK_META" :key="type" :style="{ '--jl-accent': meta.accent }"><i></i>{{ meta.label }}</span>
            </div>
            <div class="welcome-modes">
                <button v-for="item in MODES" :key="item.key" type="button" class="modecard" :data-mode="item.key" :data-current="mode === item.key" @click="start(item.key)">
                    <span class="modecard-icon"><Icon :icon="item.icon" class="w-5 h-5" /></span>
                    <span class="modecard-title">{{ item.label }}</span>
                    <span class="modecard-text">{{ item.blurb }}</span>
                    <span class="modecard-go"><Icon icon="material-symbols:play-arrow-rounded" class="w-4 h-4" /> Start</span>
                </button>
            </div>
            <p class="welcome-foot">Your browser needs this one click before it is allowed to make sound.</p>
        </div>
    </div>

    <Drawer v-model:visible="isDiscussionsOpen" header="Discussions" position="right" class="max-w-full w-120">
        <GiscusLoader />
    </Drawer>
</template>
