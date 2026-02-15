<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import type { SynthTrack, SynthTickSettings } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { Button, Slider, VirtualScroller } from 'primevue';
import { nextTick, onMounted, ref } from 'vue';

const { tracks, selectedTrack, currentTick } = useJuicyLoops();

const props = defineProps<{
    trackId: string;
}>();

const isPianoRollExpanded = ref(false);
const isTrackSettingsExpanded = ref(false);

const track = ref<SynthTrack>(tracks.value.find((t) => t.id === props.trackId) as SynthTrack);

const scroller = ref();

const availableNotes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const availableOctaves = Array.from({ length: 11 }, (_, i) => i);

const allNotes = availableOctaves.flatMap((octave) => availableNotes.map((note) => `${note}${octave}`));
allNotes.reverse();

const updateTick = (tick: SynthTickSettings, note: string) => {
    if (tick.note === note) {
        tick.isActive = !tick.isActive;
        return;
    }

    tick.isActive = true;
    tick.note = note;
};

onMounted(async () => {});

const togglePianoRoll = () => {
    isPianoRollExpanded.value = !isPianoRollExpanded.value;

    if (isPianoRollExpanded.value) {
        nextTick(() => {
            scroller.value.scrollToIndex(Math.floor(allNotes.length * 0.5));
        });
    }
};

const toggleTrackSettings = () => {
    isTrackSettingsExpanded.value = !isTrackSettingsExpanded.value;
};

const selectCurrentTrack = () => {
    selectedTrack.value = track.value as unknown as BaseTrack;
};
</script>

<template>
    <div class="pl-2 py-1 pr-6 flex flex-col gap-4" :class="selectedTrack?.id === track.id ? 'bg-surface-800 rounded-l-md' : 'rounded'">
        <div class="flex gap-4 items-start">
            <div class="w-16 font-semibold mt-1.5" @click="selectCurrentTrack">Synth</div>
            <div class="flex items-center gap-1 rounded bg-surface-700 w-24">
                <Button size="small" :text="!isPianoRollExpanded" @click="togglePianoRoll">
                    <Icon icon="material-symbols:piano" class="w-5 h-5" />
                </Button>
                <Button size="small" :text="!isTrackSettingsExpanded" @click="toggleTrackSettings">
                    <Icon icon="akar-icons:settings-vertical" class="w-5 h-5" />
                </Button>
            </div>

            <div class="flex-1 flex flex-col gap-2">
                <div class="w-full grid grid-cols-32 gap-1 justify-stretch items-stretch h-9" v-if="!isPianoRollExpanded">
                    <div v-for="(tick, tickIndex) in track.ticks" :key="tickIndex">
                        <div
                            class="w-full h-full rounded flex items-center justify-center cursor-pointer shadow border border-transparent"
                            :class="{
                                'bg-orange-500': tick.isActive,
                                'bg-surface-800': !tick.isActive && selectedTrack?.id !== track.id,
                                'bg-surface-900': !tick.isActive && selectedTrack?.id === track.id,
                                'border-orange-400/70!': currentTick === tickIndex
                            }"
                            @click="updateTick(tick, tick.note)"
                        >
                            {{ tick.note }}
                        </div>
                    </div>
                </div>

                <div class="flex flex-col -mr-4.5" v-if="isPianoRollExpanded">
                    <VirtualScroller :items="allNotes" :item-size="20" class="h-64" ref="scroller">
                        <template v-slot:item="{ item: note }">
                            <div :class="`grid grid-cols-32 gap-1 mb-1 pr-1 group`">
                                <!-- <div class="text-xs text-right">{{ note }}</div> -->
                                <div v-for="(tick, tickIndex) in track.ticks" :key="tickIndex" class="flex flex-col items-center relative">
                                    <div v-if="tickIndex === 0" class="absolute left-0.5 text-xs mt-0.5 pointer-events-none">{{ note }}</div>
                                    <div
                                        class="w-full h-5 cursor-pointer rounded shadow"
                                        :class="
                                            tick.note === note && tick.isActive
                                                ? 'bg-orange-500 group-hover:bg-orange-600 shadow-orange-700'
                                                : 'bg-surface-600 group-hover:bg-surface-700'
                                        "
                                        @click="updateTick(tick, note)"
                                    ></div>
                                </div>
                            </div>
                        </template>
                    </VirtualScroller>
                </div>

                <div class="w-full grid grid-cols-32 gap-1" v-if="isTrackSettingsExpanded">
                    <div v-for="(tick, tickIndex) in track.ticks" :key="tickIndex">
                        <div class="w-full rounded shadow p-2 bg-surface-600 flex flex-col gap-4">
                            <div class="flex flex-col items-center justify-center w-full gap-4">
                                <div>{{ Math.round(tick.volume * 100) }}%</div>
                                <Slider v-model="tick.volume" :min="0" :max="1" :step="0.01" orientation="vertical" class="w-2" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
