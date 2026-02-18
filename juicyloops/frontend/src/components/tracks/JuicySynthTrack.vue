<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { SynthTick } from '@/juicyloops/ticks/SynthTick';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { Icon } from '@iconify/vue';
import { Button, Popover, Slider, VirtualScroller } from 'primevue';
import { computed, nextTick, ref } from 'vue';
import TrackPatternSettings from './settings/TrackPatternSettings.vue';
import SynthPatternSettings from './settings/SynthPatternSettings.vue';
import SynthSettings from './settings/SynthSettings.vue';
import TrackVolumeSettings from './settings/TrackVolumeSettings.vue';

const { tracks, currentTick, removeTrack, duplicateTrack } = useJuicyLoops();

const props = defineProps<{
    trackId: string;
    trackIndex: number;
}>();

const track = computed(() => tracks.value.find((t) => t.id === props.trackId) as SynthTrack);

const isPianoRollExpanded = ref(false);
const isVolumeSettingsExpanded = ref(false);

const scroller = ref();
const settingsPopover = ref();
const volumePopover = ref();

const availableNotes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const availableOctaves = Array.from({ length: 11 }, (_, i) => i);

const allNotes = availableOctaves.flatMap((octave) => availableNotes.map((note) => `${note}${octave}`));
allNotes.reverse();

const updateTick = (tick: SynthTick, note: string) => {
    if (tick.note === note) {
        tick.isActive = !tick.isActive;
        return;
    }

    tick.isActive = true;
    tick.note = note;
};

const togglePianoRoll = async () => {
    isPianoRollExpanded.value = !isPianoRollExpanded.value;

    if (isPianoRollExpanded.value) {
        await nextTick();

        const activeTick = track.value.ticks.find((tick) => tick.isActive);
        const activeNoteIndex = activeTick ? allNotes.findIndex((note) => note === activeTick.note) : -1;
        if (activeNoteIndex !== -1) {
            scroller.value.scrollToIndex(activeNoteIndex - 4);
            return;
        }
        scroller.value.scrollToIndex(Math.floor(allNotes.length * 0.5));
    }
};

const showSettings = (event: any) => {
    settingsPopover.value.toggle(event);
};

const showVolumeSettings = (event: any) => {
    volumePopover.value.toggle(event);
};
</script>

<template>
    <div class="pl-2 py-1 pr-6 flex flex-col gap-2 track">
        <div class="flex gap-2 items-start">
            <div class="font-semibold flex h-9 rounded px-2 items-center gap-2">
                <Icon icon="qlementine-icons:synthesizer-16" class="w-5 h-5" />
                <div class="text-xs w-6 text-right">#{{ props.trackIndex + 1 }}</div>
            </div>

            <div class="flex h-9 gap-1 items-center rounded bg-surface-800">
                <Button :text="!track.isMuted" size="small" @click="track.toggleMute()">
                    <Icon icon="fad:mute" class="w-5 h-5" />
                </Button>
                <Button text size="small" @click="showVolumeSettings">
                    <Icon icon="ic:baseline-volume-up" class="w-5 h-5" />
                </Button>
            </div>

            <div class="flex items-center gap-1 rounded bg-surface-800 w-49 h-9">
                <Button size="small" :text="!isPianoRollExpanded" @click="togglePianoRoll">
                    <Icon icon="material-symbols:piano" class="w-5 h-5" />
                </Button>
                <Button size="small" :text="!isVolumeSettingsExpanded" @click="isVolumeSettingsExpanded = !isVolumeSettingsExpanded">
                    <Icon icon="akar-icons:settings-vertical" class="w-5 h-5" />
                </Button>
                <Button size="small" text @click="showSettings">
                    <Icon icon="ic:baseline-settings" class="w-5 h-5" />
                </Button>
                <Button size="small" text @click="duplicateTrack(track.id)">
                    <Icon icon="mdi:content-copy" class="w-5 h-5" />
                </Button>
                <Button size="small" text @click="removeTrack(track.id)">
                    <Icon icon="mdi:trash" class="w-5 h-5" />
                </Button>
            </div>

            <div class="flex-1 flex flex-col gap-2">
                <div class="w-full grid grid-cols-32 gap-1 justify-stretch items-stretch h-9">
                    <div v-for="(tick, tickIndex) in track.ticks" :key="tickIndex">
                        <div
                            class="w-full h-full rounded flex items-center justify-center cursor-pointer shadow border border-transparent tick text-sm"
                            :class="{
                                'tick--active': tick.isActive,
                                'tick--inactive': !tick.isActive,
                                'tick--current': currentTick === tickIndex,
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
                                <div v-for="(tick, tickIndex) in track.ticks" :key="tickIndex" class="flex flex-col items-center relative">
                                    <div v-if="tickIndex === 0" class="absolute left-0.5 text-xs mt-0.5 pointer-events-none z-20 text-white">{{ note }}</div>
                                    <div
                                        class="w-full h-5 cursor-pointer rounded shadow border border-transparent bg-surface-800 group-hover:bg-surface-700 pianotick"
                                        :class="{
                                            'pianotick--active': tick.note === note && tick.isActive,
                                            'pianotick--inactive': tick.note !== note || !tick.isActive,
                                            'pianotick--current': currentTick === tickIndex,
                                        }"
                                        @click="updateTick(tick, note)"
                                    ></div>
                                </div>
                            </div>
                        </template>
                    </VirtualScroller>
                </div>

                <TrackVolumeSettings :track="track" v-if="isVolumeSettingsExpanded" />
            </div>
        </div>
    </div>

    <Popover ref="settingsPopover">
        <div class="flex items-center gap-1">
            <SynthSettings :track="track" />
            <TrackPatternSettings :track="track" />
            <SynthPatternSettings :track="track" />
        </div>
    </Popover>

    <Popover ref="volumePopover">
        <div>
            <Slider v-model="track.volume" :min="-40" :max="6" :step="0.2" @change="track.setVolume(track.volume)" orientation="vertical" />
        </div>
    </Popover>
</template>
