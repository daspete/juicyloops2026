<script setup lang="ts">
import { Drawer } from 'primevue';
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue';
import { Icon } from '@iconify/vue';
import { MAX_BPM, MIN_BPM, useJuicyLoops } from '@/composables/useJuicyLoops';
import { useHoldRepeat } from '@/composables/useHoldRepeat';
import { useTheme } from '@/composables/useTheme';
import type { TrackType } from '@/juicyloops/tracks/registry';
import { TRACK_META } from './tracks/trackMeta';
import { positionLabel } from './tracks/steps';
import { STEP_COUNT } from '@/juicyloops/constants';
import JuicySynthTrack from './tracks/JuicySynthTrack.vue';
import JuicySamplerTrack from './tracks/JuicySamplerTrack.vue';
import JuicyMicrophoneTrack from './tracks/JuicyMicrophoneTrack.vue';
import StepRuler from './tracks/StepRuler.vue';
import GiscusLoader from './GiscusLoader.vue';

const { engine, bpm, setBpm, tapTempo, currentTick, isPlaying, togglePlay, tracks, addTrack } = useJuicyLoops();
const { theme, toggleTheme } = useTheme();

const isInitialized = ref(false);
const isDiscussionsOpen = ref(false);

const initializeEngine = async () => {
    await engine.initialize();
    isInitialized.value = true;
};

/** Which component renders which track type. */
const TRACK_COMPONENTS: Record<TrackType, Component> = {
    synth: JuicySynthTrack,
    sampler: JuicySamplerTrack,
    microphone: JuicyMicrophoneTrack,
};

const TRACK_TYPES = Object.keys(TRACK_META) as TrackType[];

const position = computed(() => positionLabel(currentTick.value));
const loopProgress = computed(() => `${((currentTick.value + 1) / STEP_COUNT) * 100}%`);

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
            <div class="w-40 shrink-0">
                <img src="/juicyloopslogo.svg" alt="Juicy Loops" class="logo" />
            </div>

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
            <div class="min-w-4xl max-w-7xl mx-auto px-4 py-4 flex flex-col gap-2">
                <template v-if="tracks.length">
                    <StepRuler :current-tick="currentTick" />
                    <div v-for="(track, trackIndex) in tracks" :key="track.id">
                        <component :is="TRACK_COMPONENTS[track.type]" :track="track" :track-index="trackIndex" />
                    </div>

                    <div class="flex items-center gap-2 px-2 pt-2">
                        <span class="text-xs font-semibold text-(--jl-muted) uppercase tracking-wider mr-1">Add</span>
                        <button
                            v-for="type in TRACK_TYPES"
                            :key="type"
                            type="button"
                            class="chip"
                            :style="{ '--jl-accent': TRACK_META[type].accent }"
                            @click="addTrack(type)"
                        >
                            <Icon :icon="TRACK_META[type].icon" class="w-4 h-4" :style="{ color: TRACK_META[type].accent }" />
                            <span>{{ TRACK_META[type].label }}</span>
                        </button>
                    </div>
                </template>

                <div v-else class="flex flex-col items-center gap-8 pt-16 pb-8 text-center">
                    <div>
                        <h2 class="font-display font-bold text-4xl tracking-tight">Start with a track</h2>
                        <p class="mt-2 text-(--jl-muted)">Every track is a loop of 32 steps. Mix and match as many as you like.</p>
                    </div>
                    <div class="flex flex-wrap justify-center gap-4">
                        <button
                            v-for="type in TRACK_TYPES"
                            :key="type"
                            type="button"
                            class="addcard"
                            :style="{ '--jl-accent': TRACK_META[type].accent }"
                            @click="addTrack(type)"
                        >
                            <Icon :icon="TRACK_META[type].icon" class="w-8 h-8" :style="{ color: TRACK_META[type].accent }" />
                            <span class="font-display font-bold text-xl">{{ TRACK_META[type].label }}</span>
                            <span class="text-sm text-(--jl-muted) leading-snug">{{ TRACK_META[type].blurb }}</span>
                        </button>
                    </div>
                </div>
            </div>
        </main>

        <footer class="flex justify-center py-2 text-xs text-(--jl-muted) shrink-0">
            Made with ❤️ in Vienna by&nbsp;<a href="https://daspete.at" target="_blank" rel="noopener noreferrer" class="text-(--jl-synth) hover:underline"
                >Pete</a
            >
        </footer>
    </div>

    <div v-if="!isInitialized" class="fixed inset-0 z-50 flex items-center justify-center bg-(--jl-bg)/80 backdrop-blur-sm p-4">
        <div class="w-full max-w-md rounded-2xl border border-(--jl-line) bg-(--jl-surface) p-8 flex flex-col gap-5 shadow-2xl">
            <div class="w-44">
                <img src="/juicyloopslogo.svg" alt="Juicy Loops" class="logo" />
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
