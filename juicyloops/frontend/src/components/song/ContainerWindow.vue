<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useContainerWindows, type ContainerWindowState } from '@/composables/useContainerWindows';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import type { WindowArea } from '../ui/floatingWindow';
import FloatingWindow from '../ui/FloatingWindow.vue';
import ContainerTracks from '../tracks/ContainerTracks.vue';

/**
 * One container's tracks in a floating window over the song. Everything in it works as in the track view,
 * and while the song plays the playhead shows where the song is inside this container.
 */
const props = defineProps<{
    state: ContainerWindowState;
    container: TrackContainer;
    hue: number;
    /** Where the song plays this container right now, null while no clip of it sounds. */
    step: number | null;
    /** The size of the song view the window lives in. */
    area: WindowArea;
}>();

const { renameContainer } = useJuicyLoops();
const { focus, close } = useContainerWindows();
const { isMixerOpen, toggleMixer } = useWorkspace();
const router = useRouter();

const accent = computed(() => `hsl(${props.hue} 80% 62%)`);

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
    <FloatingWindow
        :state="props.state"
        :area="props.area"
        :accent="accent"
        :label="`${props.container.name}: tracks`"
        @focus="focus(props.container.id)"
        @close="close(props.container.id)"
    >
        <template #title>
            <input
                v-if="isRenaming"
                ref="nameInput"
                v-model="draft"
                class="fwin-input"
                aria-label="Container name"
                @keydown.enter="commitRename"
                @keydown.esc="isRenaming = false"
                @blur="commitRename"
            />
            <span v-else class="fwin-title" v-tooltip.bottom="{ value: 'Double-click to rename', showDelay: 600 }" @dblclick.stop="startRename">{{
                props.container.name
            }}</span>
            <span class="fwin-meta">
                {{ trackCount }}
                <span v-if="props.step !== null" class="fwin-live" v-tooltip.bottom="'Playing in the song right now'"><i></i>live</span>
            </span>
        </template>

        <template #actions>
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
        </template>

        <ContainerTracks :container="props.container" :step="props.step" compact />
    </FloatingWindow>
</template>
