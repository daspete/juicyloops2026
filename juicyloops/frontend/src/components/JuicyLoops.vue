<script setup lang="ts">
import { Drawer } from 'primevue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { Icon } from '@iconify/vue';
import { MAX_BPM, MIN_BPM, useJuicyLoops } from '@/composables/useJuicyLoops';
import { useHoldRepeat } from '@/composables/useHoldRepeat';
import { useTheme } from '@/composables/useTheme';
import { positionLabel } from './tracks/steps';
import { STEP_COUNT } from '@/juicyloops/constants';
import GiscusLoader from './GiscusLoader.vue';
import JuicyLogo from './JuicyLogo.vue';

/**
 * The application shell: transport, view switcher and the frame around the editors.
 * The track editor and the song editor are routes rendered into the main area.
 */
const { engine, bpm, setBpm, tapTempo, currentTick, currentSection, isPlaying, togglePlay, setMode, song, tracks } = useJuicyLoops();
const { theme, toggleTheme } = useTheme();
const route = useRoute();

/* What you see is what you hear: the song view plays the arrangement, the track view loops every track. */
const isSongView = computed(() => route.name === 'app.song');
watch(isSongView, (value) => setMode(value ? 'song' : 'loop'), { immediate: true });

const VIEWS = [
    { name: 'app.index', label: 'Tracks', icon: 'mdi:dots-grid', hint: 'Build loops' },
    { name: 'app.song', label: 'Song', icon: 'mdi:view-sequential-outline', hint: 'Arrange the loops' },
] as const;

const isInitialized = ref(false);
const isDiscussionsOpen = ref(false);

const initializeEngine = async () => {
    await engine.initialize();
    isInitialized.value = true;
};

const position = computed(() => positionLabel(currentTick.value, isSongView.value ? currentSection.value : 0));

/** The progress bar spans one pattern in the track view and the whole song in the song view. */
const loopProgress = computed(() => {
    const sections = isSongView.value ? song.value.length : 1;
    const section = isSongView.value ? currentSection.value : 0;
    return `${((section * STEP_COUNT + currentTick.value + 1) / (sections * STEP_COUNT)) * 100}%`;
});

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

/** Space plays and stops, like in every DAW. */
const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'Space' || !isInitialized.value || isTypingTarget(event.target)) {
        return;
    }
    event.preventDefault();
    togglePlay();
};

onMounted(() => window.addEventListener('keydown', onKeyDown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown));
</script>

<template>
    <div class="flex flex-col w-full h-full">
        <header class="flex items-center gap-4 px-4 h-16 shrink-0 overflow-x-auto">
            <div class="h-8 shrink-0">
                <JuicyLogo />
            </div>

            <nav class="viewswitch shrink-0" aria-label="Editor">
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
                    <span v-if="view.name === 'app.index' && tracks.length" class="viewswitch-count">{{ tracks.length }}</span>
                </RouterLink>
            </nav>

            <div class="flex-1 flex items-center justify-center gap-5">
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

                    <div class="flex items-center gap-1 rounded-full bg-(--jl-cell) px-1 h-9">
                        <button
                            type="button"
                            class="iconbtn"
                            aria-label="Slower"
                            v-tooltip.bottom="{ value: 'Hold to keep going', showDelay: 800 }"
                            v-on="holdSlower"
                        >
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
                        <span class="text-xs font-semibold text-(--jl-muted) pr-1">BPM</span>
                        <button
                            type="button"
                            class="iconbtn"
                            aria-label="Faster"
                            v-tooltip.bottom="{ value: 'Hold to keep going', showDelay: 800 }"
                            v-on="holdFaster"
                        >
                            <Icon icon="mdi:plus" class="w-4 h-4" />
                        </button>
                        <button type="button" class="iconbtn" v-tooltip.bottom="'Tap along to set the tempo'" @click="tapTempo">Tap</button>
                    </div>
                </div>

                <div
                    class="hidden sm:flex items-center gap-2 font-mono text-sm w-20"
                    :class="isPlaying ? 'text-(--jl-text)' : 'text-(--jl-muted)'"
                    aria-live="off"
                >
                    <span class="w-1.5 h-1.5 rounded-full" :class="isPlaying ? 'bg-(--jl-synth)' : 'bg-(--jl-line)'"></span>
                    {{ position }}
                </div>
            </div>

            <button
                type="button"
                class="iconbtn"
                :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
                v-tooltip.bottom="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
                @click="toggleTheme"
            >
                <Icon :icon="theme === 'dark' ? 'ph:sun' : 'ph:moon'" class="w-5 h-5" />
            </button>
            <button
                type="button"
                class="iconbtn"
                aria-label="Questions and feedback"
                v-tooltip.bottom="'Questions and feedback'"
                @click="isDiscussionsOpen = true"
            >
                <Icon icon="ph:chats" class="w-5 h-5" />
            </button>
        </header>
        <div class="loopbar shrink-0" aria-hidden="true">
            <div class="loopbar-fill" :data-playing="isPlaying" :style="{ width: loopProgress }"></div>
        </div>

        <main class="flex-1 min-h-0 overflow-auto">
            <Suspense>
                <RouterView v-slot="{ Component }">
                    <component :is="Component" />
                </RouterView>
            </Suspense>
        </main>

        <footer class="flex justify-center py-2 text-xs text-(--jl-muted) shrink-0">
            Made with ❤️ in Vienna by&nbsp;<a href="https://daspete.at" target="_blank" rel="noopener noreferrer" class="text-(--jl-synth) hover:underline"
                >Pete</a
            >
        </footer>
    </div>

    <div v-if="!isInitialized" class="fixed inset-0 z-50 flex items-center justify-center bg-(--jl-bg)/80 backdrop-blur-sm p-4">
        <div class="w-full max-w-md rounded-2xl border border-(--jl-line) bg-(--jl-surface) p-8 flex flex-col gap-5 shadow-2xl">
            <div class="h-10">
                <JuicyLogo />
            </div>
            <h1 class="font-display font-extrabold text-4xl leading-none tracking-tight">Make a loop<br />in a minute.</h1>
            <p class="text-(--jl-muted) leading-relaxed">
                Add a track, tap some steps, press play. Your browser needs one click before it is allowed to make sound.
            </p>
            <button type="button" class="playbtn playbtn--wide self-start" @click="initializeEngine">
                <Icon icon="material-symbols:play-arrow-rounded" class="w-6 h-6" />
                <span>Start</span>
            </button>
        </div>
    </div>

    <Drawer v-model:visible="isDiscussionsOpen" header="Discussions" position="right" class="max-w-full w-120">
        <GiscusLoader />
    </Drawer>
</template>
