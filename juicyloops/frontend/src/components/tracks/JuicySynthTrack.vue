<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { ALL_NOTES_DESCENDING, noteLengthSteps } from '@/juicyloops/notes';
import type { SynthTick } from '@/juicyloops/ticks/SynthTick';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { VirtualScroller } from 'primevue';
import { nextTick, ref, useTemplateRef } from 'vue';
import TickGrid from './TickGrid.vue';
import TrackShell from './TrackShell.vue';
import SynthEnvelopeSettings from './settings/SynthEnvelopeSettings.vue';
import SynthLengthSettings from './settings/SynthLengthSettings.vue';
import SynthSettings from './settings/SynthSettings.vue';
import { BEATS } from './steps';

const props = defineProps<{
    track: SynthTrack;
    trackIndex: number;
}>();

const { currentTick } = useJuicyLoops();

const ROW_HEIGHT = 24;

const isPianoRollExpanded = ref(false);
const isLengthLaneOpen = ref(false);

/**
 * What each cell of one piano roll row shows: the head of a note (with the fraction of the cell it fills),
 * the tail of a longer note from an earlier step, or nothing.
 */
type RollCell = { kind: 'head'; fill: number } | { kind: 'tail' } | { kind: 'ghost' } | null;

const rowCells = (note: string): RollCell[] => {
    const cells: RollCell[] = props.track.ticks.map((tick) => (tick.note === note && !tick.isActive ? { kind: 'ghost' } : null));
    props.track.ticks.forEach((tick, index) => {
        if (tick.note !== note || !tick.isActive) {
            return;
        }
        const steps = noteLengthSteps(tick.duration);
        cells[index] = { kind: 'head', fill: Math.min(1, steps) };
        for (let offset = 1; offset < steps && index + offset < cells.length; offset++) {
            if (cells[index + offset]?.kind !== 'head') {
                cells[index + offset] = { kind: 'tail' };
            }
        }
    });
    return cells;
};
const scroller = useTemplateRef<InstanceType<typeof VirtualScroller>>('scroller');

/** In the piano roll, clicking a tick's own note toggles it, clicking another note moves the tick there and activates it. */
const placeNote = (tick: SynthTick, note: string) => {
    if (tick.note === note) {
        tick.isActive = !tick.isActive;
        return;
    }

    tick.isActive = true;
    tick.note = note;
};

const isBlackKey = (note: string) => note.includes('#');
const isC = (note: string) => note.startsWith('C') && !isBlackKey(note);

/** Scrolls the roll so the pattern's notes are in view (or C5 when nothing is set yet). */
const scrollToPattern = async () => {
    await nextTick();

    const activeTick = props.track.ticks.find((tick) => tick.isActive);
    const note = activeTick?.note ?? props.track.ticks[0]?.note ?? 'C5';
    const index = ALL_NOTES_DESCENDING.indexOf(note);
    scroller.value?.scrollToIndex(Math.max(0, index - 5));
};

const togglePianoRoll = async () => {
    isPianoRollExpanded.value = !isPianoRollExpanded.value;
    if (isPianoRollExpanded.value) {
        await scrollToPattern();
    }
};

const shiftOctave = async (direction: 1 | -1) => {
    props.track.shiftOctave(direction);
    await scrollToPattern();
};
</script>

<template>
    <TrackShell :track="props.track" :track-index="props.trackIndex" has-grid>
        <template #actions>
            <button
                type="button"
                class="iconbtn"
                :data-active="isPianoRollExpanded"
                v-tooltip.bottom="'Pick the pitch of each step'"
                :aria-pressed="isPianoRollExpanded"
                @click="togglePianoRoll"
            >
                <Icon icon="material-symbols:piano" class="w-4 h-4" />
                <span>Notes</span>
            </button>
            <button
                type="button"
                class="iconbtn"
                :data-active="isLengthLaneOpen"
                v-tooltip.bottom="'How long each note rings'"
                :aria-pressed="isLengthLaneOpen"
                @click="isLengthLaneOpen = !isLengthLaneOpen"
            >
                <Icon icon="mdi:arrow-expand-horizontal" class="w-4 h-4" />
                <span>Length</span>
            </button>
        </template>

        <TickGrid :ticks="props.track.ticks" :current-tick="currentTick" @paint="(tick, _index, active) => (tick.isActive = active)">
            <template #default="{ tick }">{{ tick.note }}</template>
        </TickGrid>

        <SynthLengthSettings v-if="isLengthLaneOpen" :track="props.track" />

        <div v-if="isPianoRollExpanded" class="pianoroll flex flex-col gap-1.5">
            <VirtualScroller :items="ALL_NOTES_DESCENDING" :item-size="ROW_HEIGHT" class="h-72 -mr-1.5" ref="scroller">
                <template v-slot:item="{ item: note }">
                    <div class="pianorow" :class="{ 'pianorow--black': isBlackKey(note), 'pianorow--c': isC(note) }">
                        <div class="pianokey">{{ note }}</div>
                        <div class="steps">
                            <template v-for="(beat, beatIndex) in BEATS" :key="beatIndex">
                                <div class="beat">
                                    <div
                                        v-for="tickIndex in beat"
                                        :key="tickIndex"
                                        class="pianotick"
                                        :class="{
                                            'pianotick--active': rowCells(note)[tickIndex]?.kind === 'head',
                                            'pianotick--tail': rowCells(note)[tickIndex]?.kind === 'tail',
                                            'pianotick--ghost': rowCells(note)[tickIndex]?.kind === 'ghost',
                                            'pianotick--current': currentTick === tickIndex,
                                        }"
                                        :style="rowCells(note)[tickIndex]?.kind === 'head' ? { '--fill': (rowCells(note)[tickIndex] as { fill: number }).fill } : undefined"
                                        :title="`Step ${tickIndex + 1}: ${note}`"
                                        @click="placeNote(props.track.ticks[tickIndex]!, note)"
                                    ></div>
                                </div>
                            </template>
                        </div>
                    </div>
                </template>
            </VirtualScroller>
            <div class="flex items-center gap-2 pl-15">
                <button type="button" class="chip" @click="shiftOctave(-1)">
                    <Icon icon="mdi:arrow-down" class="w-4 h-4" />
                    <span>Octave down</span>
                </button>
                <button type="button" class="chip" @click="shiftOctave(1)">
                    <Icon icon="mdi:arrow-up" class="w-4 h-4" />
                    <span>Octave up</span>
                </button>
                <span class="text-xs text-(--jl-muted)">Click a cell to put that step on that note. Longer notes stretch to the right, outlined cells are silent steps.</span>
            </div>
        </div>

        <template #sound>
            <SynthSettings :track="props.track" />
            <SynthEnvelopeSettings :track="props.track" />
        </template>
    </TrackShell>
</template>
