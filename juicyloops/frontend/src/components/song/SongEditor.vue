<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { STEP_COUNT } from '@/juicyloops/constants';
import { BARS_PER_SECTION, BEATS_PER_BAR } from '../tracks/steps';
import { TRACK_META } from '../tracks/trackMeta';
import PatternPreview from './PatternPreview.vue';

/**
 * The song view: an arrangement grid with one row per track and one column per section.
 * A lit cell means "this track's loop plays during this section".
 * Press a cell to flip it, keep the pointer down and sweep across to paint the same state onto its neighbours.
 */
const { bpm, tracks, song, currentTick, currentSection, isPlaying, playSection } = useJuicyLoops();

const bars = computed(() => song.value.length * BARS_PER_SECTION);

/** Length of the whole song at the current tempo, as `m:ss`. */
const duration = computed(() => {
    const seconds = Math.round((bars.value * BEATS_PER_BAR * 60) / bpm.value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

const barRange = (index: number) => {
    const first = index * BARS_PER_SECTION + 1;
    return BARS_PER_SECTION === 1 ? `bar ${first}` : `bars ${first}–${first + BARS_PER_SECTION - 1}`;
};

const isCurrent = (index: number) => isPlaying.value && currentSection.value === index;
const sectionProgress = computed(() => `${((currentTick.value + 1) / STEP_COUNT) * 100}%`);

const gridStyle = computed(() => ({
    gridTemplateColumns: `var(--jl-track-head) repeat(${song.value.length}, var(--jl-section-width)) min-content`,
}));

/* ---- painting cells ---- */

/** The state we are painting while the pointer is down, null when idle. */
const painting = ref<boolean | null>(null);

const cellAt = (event: PointerEvent): { section: number; trackId: string } | null => {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-section]');
    return cell ? { section: Number(cell.dataset.section), trackId: cell.dataset.track! } : null;
};

const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
        return;
    }

    const cell = cellAt(event);
    if (!cell) {
        return;
    }

    painting.value = !song.value.plays(cell.section, cell.trackId);
    song.value.setPlays(cell.section, cell.trackId, painting.value);
};

const onPointerMove = (event: PointerEvent) => {
    if (painting.value === null) {
        return;
    }

    const cell = cellAt(event);
    if (cell) {
        song.value.setPlays(cell.section, cell.trackId, painting.value);
    }
};

const stopPainting = () => (painting.value = null);

/** Keyboard activation arrives as a click with `detail === 0`; pointer clicks were already handled on pointerdown. */
const onCellClick = (event: MouseEvent, section: number, trackId: string) => {
    if (event.detail === 0) {
        song.value.toggle(section, trackId);
    }
};

onMounted(() => window.addEventListener('pointerup', stopPainting));
onBeforeUnmount(() => window.removeEventListener('pointerup', stopPainting));
</script>

<template>
    <div class="min-w-4xl max-w-7xl mx-auto px-4 py-4 flex flex-col gap-3">
        <div v-if="!tracks.length" class="flex flex-col items-center gap-6 pt-16 pb-8 text-center">
            <div>
                <h2 class="font-display font-bold text-4xl tracking-tight">Nothing to arrange yet</h2>
                <p class="mt-2 text-(--jl-muted)">A song is built from tracks. Make a few loops first, then come back and lay them out.</p>
            </div>
            <RouterLink :to="{ name: 'app.index' }" class="playbtn playbtn--wide">
                <Icon icon="mdi:dots-grid" class="w-5 h-5" />
                <span>Go to tracks</span>
            </RouterLink>
        </div>

        <template v-else>
            <div class="flex items-end gap-4 px-2">
                <div>
                    <h2 class="font-display font-bold text-2xl tracking-tight leading-none">Song</h2>
                    <p class="mt-1.5 text-sm text-(--jl-muted)">
                        <span class="font-mono">{{ song.length }}</span> {{ song.length === 1 ? 'section' : 'sections' }} ·
                        <span class="font-mono">{{ bars }}</span> bars · <span class="font-mono">{{ duration }}</span> at
                        <span class="font-mono">{{ bpm }}</span> BPM
                    </p>
                </div>
                <div class="flex-1"></div>
                <p v-if="song.isEmpty" class="song-hint">Tap a cell to place a loop, or drag across a few. Click a section number to play from there.</p>
                <button type="button" class="chip" @click="song.addSection()">
                    <Icon icon="mdi:plus" class="w-4 h-4" />
                    <span>Add section</span>
                </button>
            </div>

            <div class="song">
                <div class="song-grid" :style="gridStyle" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointercancel="stopPainting">
                    <div class="song-corner">
                        <span class="text-xs font-semibold text-(--jl-muted) uppercase tracking-wider">Track</span>
                    </div>
                    <div v-for="(section, index) in song.sections" :key="section.id" class="section-head" :data-current="isCurrent(index)">
                        <button
                            type="button"
                            class="section-num"
                            v-tooltip.bottom="{ value: 'Play from here', showDelay: 600 }"
                            :aria-label="`Play from section ${index + 1}`"
                            @click="playSection(index)"
                        >
                            <span class="font-display font-bold text-lg leading-none">{{ index + 1 }}</span>
                            <span class="text-[0.65rem] text-(--jl-muted)">{{ barRange(index) }}</span>
                        </button>
                        <div class="section-tools">
                            <button
                                type="button"
                                class="iconbtn iconbtn--tiny"
                                aria-label="Move section left"
                                :disabled="index === 0"
                                @click="song.moveSection(section.id, -1)"
                            >
                                <Icon icon="mdi:chevron-left" class="w-3.5 h-3.5" />
                            </button>
                            <button type="button" class="iconbtn iconbtn--tiny" aria-label="Duplicate section" @click="song.duplicateSection(section.id)">
                                <Icon icon="mdi:content-copy" class="w-3 h-3" />
                            </button>
                            <button
                                type="button"
                                class="iconbtn iconbtn--tiny iconbtn--danger"
                                aria-label="Remove section"
                                :disabled="song.length === 1"
                                @click="song.removeSection(section.id)"
                            >
                                <Icon icon="mdi:trash-can-outline" class="w-3.5 h-3.5" />
                            </button>
                            <button
                                type="button"
                                class="iconbtn iconbtn--tiny"
                                aria-label="Move section right"
                                :disabled="index === song.length - 1"
                                @click="song.moveSection(section.id, 1)"
                            >
                                <Icon icon="mdi:chevron-right" class="w-3.5 h-3.5" />
                            </button>
                        </div>
                        <div v-if="isCurrent(index)" class="section-progress" :style="{ width: sectionProgress }"></div>
                    </div>
                    <div class="song-add">
                        <button type="button" class="iconbtn" aria-label="Add section" v-tooltip.bottom="'Add section'" @click="song.addSection()">
                            <Icon icon="mdi:plus" class="w-4 h-4" />
                        </button>
                    </div>

                    <template v-for="(track, trackIndex) in tracks" :key="track.id">
                        <div class="song-head" :class="{ 'song-head--muted': track.isMuted }" :style="{ '--jl-accent': TRACK_META[track.type].accent }">
                            <div class="flex items-center gap-2 h-6">
                                <span class="track-dot"></span>
                                <Icon :icon="TRACK_META[track.type].icon" class="w-4 h-4" />
                                <span class="font-semibold">{{ TRACK_META[track.type].label }}</span>
                                <span class="font-mono text-xs text-(--jl-muted)">{{ trackIndex + 1 }}</span>
                                <div class="flex-1"></div>
                                <button
                                    type="button"
                                    class="iconbtn iconbtn--tiny"
                                    v-tooltip.bottom="{ value: 'Play in every section', showDelay: 600 }"
                                    aria-label="Play in every section"
                                    @click="song.setPlaysEverywhere(track.id, true)"
                                >
                                    All
                                </button>
                                <button
                                    type="button"
                                    class="iconbtn iconbtn--tiny"
                                    v-tooltip.bottom="{ value: 'Remove from every section', showDelay: 600 }"
                                    aria-label="Remove from every section"
                                    :disabled="song.countSections(track.id) === 0"
                                    @click="song.setPlaysEverywhere(track.id, false)"
                                >
                                    None
                                </button>
                                <button
                                    type="button"
                                    class="iconbtn iconbtn--tiny"
                                    :data-active="track.isMuted"
                                    v-tooltip.bottom="track.isMuted ? 'Unmute' : 'Mute'"
                                    :aria-label="track.isMuted ? 'Unmute' : 'Mute'"
                                    :aria-pressed="track.isMuted"
                                    @click="track.toggleMute()"
                                >
                                    <Icon :icon="track.isMuted ? 'mdi:volume-off' : 'mdi:volume-high'" class="w-3.5 h-3.5" />
                                </button>
                            </div>
                            <PatternPreview :ticks="track.ticks" class="mt-1" />
                        </div>
                        <button
                            v-for="(section, index) in song.sections"
                            :key="section.id"
                            type="button"
                            class="songcell"
                            :style="{ '--jl-accent': TRACK_META[track.type].accent }"
                            :data-on="song.plays(index, track.id)"
                            :data-current="isCurrent(index)"
                            :data-muted="track.isMuted"
                            :data-section="index"
                            :data-track="track.id"
                            :aria-label="`${TRACK_META[track.type].label} ${trackIndex + 1} in section ${index + 1}`"
                            :aria-pressed="song.plays(index, track.id)"
                            @click="onCellClick($event, index, track.id)"
                        >
                            <PatternPreview v-if="song.plays(index, track.id)" :ticks="track.ticks" class="songcell-preview" />
                        </button>
                        <div></div>
                    </template>
                </div>
            </div>
        </template>
    </div>
</template>
