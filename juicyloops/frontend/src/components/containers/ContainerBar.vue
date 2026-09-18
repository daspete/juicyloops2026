<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useConfirm } from 'primevue';
import { nextTick, ref } from 'vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import { TRACK_META } from '../tracks/trackMeta';

/**
 * The strip of container tabs above the tracks. One container is current: its tracks are what you see and hear.
 * Double-click a tab (or use the pencil) to rename it. The channel button opens the mixer on the right,
 * where the container's channel strip (level, pan and an effect rack every track runs through) sits above the master.
 */
const { containers, currentContainer, selectContainer, addContainer, removeContainer, duplicateContainer, renameContainer, song } = useJuicyLoops();
const { isMixerOpen, toggleMixer } = useWorkspace();
const confirm = useConfirm();

const editingId = ref<string | null>(null);
const draft = ref('');
const input = ref<HTMLInputElement[]>([]);

const startRename = async (id: string, name: string) => {
    editingId.value = id;
    draft.value = name;
    await nextTick();
    input.value[0]?.focus();
    input.value[0]?.select();
};

const commitRename = () => {
    if (editingId.value) {
        renameContainer(editingId.value, draft.value);
    }
    editingId.value = null;
};

const cancelRename = () => (editingId.value = null);

const confirmRemove = (event: MouseEvent) => {
    const container = currentContainer.value;
    const placed = song.value.countClips(container.id);
    confirm.require({
        target: event.currentTarget as HTMLElement,
        message: placed
            ? `Remove "${container.name}" with its ${container.tracks.length} tracks? It is placed ${placed} ${placed === 1 ? 'time' : 'times'} in the song.`
            : `Remove "${container.name}" with its ${container.tracks.length} tracks?`,
        acceptLabel: 'Remove',
        rejectLabel: 'Keep',
        acceptProps: { severity: 'danger', size: 'small' },
        rejectProps: { text: true, size: 'small' },
        accept: () => removeContainer(container.id),
    });
};
</script>

<template>
    <div class="scenes">
        <span class="eyebrow">Containers</span>

        <div class="scenes-list">
            <div
                v-for="container in containers"
                :key="container.id"
                class="ctab"
                :data-active="container.id === currentContainer.id"
                role="button"
                tabindex="0"
                :aria-pressed="container.id === currentContainer.id"
                @click="selectContainer(container.id)"
                @keydown.enter.self="selectContainer(container.id)"
                @keydown.space.self.prevent="selectContainer(container.id)"
                @dblclick="startRename(container.id, container.name)"
            >
                <input
                    v-if="editingId === container.id"
                    ref="input"
                    v-model="draft"
                    class="ctab-input"
                    aria-label="Container name"
                    @keydown.enter="commitRename"
                    @keydown.esc="cancelRename"
                    @blur="commitRename"
                    @click.stop
                />
                <span v-else class="ctab-name">{{ container.name }}</span>
                <span class="ctab-dots" aria-hidden="true">
                    <span v-for="track in container.tracks.slice(0, 6)" :key="track.id" class="ctab-dot" :style="{ background: TRACK_META[track.type].accent }"></span>
                </span>
                <span class="ctab-count">{{ container.tracks.length }}</span>
            </div>

            <button type="button" class="iconbtn" aria-label="New container" v-tooltip.bottom="'New container'" @click="addContainer()">
                <Icon icon="mdi:plus" class="w-4 h-4" />
                <span>New</span>
            </button>
        </div>

        <div class="flex-1"></div>

        <button type="button" class="chip" :data-active="isMixerOpen" :aria-pressed="isMixerOpen" v-tooltip.bottom="'Level, pan and effects for the whole container, in the mixer'" @click="toggleMixer">
            <Icon icon="mdi:tune-vertical" class="w-4 h-4" />
            <span>Channel</span>
        </button>
        <span class="vrule"></span>

        <button type="button" class="iconbtn" aria-label="Rename container" v-tooltip.bottom="'Rename'" @click="startRename(currentContainer.id, currentContainer.name)">
            <Icon icon="mdi:pencil-outline" class="w-4 h-4" />
        </button>
        <button type="button" class="iconbtn" aria-label="Duplicate container" v-tooltip.bottom="'Duplicate with all tracks'" @click="duplicateContainer(currentContainer.id)">
            <Icon icon="mdi:content-copy" class="w-4 h-4" />
        </button>
        <button
            type="button"
            class="iconbtn iconbtn--danger"
            aria-label="Remove container"
            v-tooltip.bottom="containers.length === 1 ? 'The last container stays' : 'Remove container'"
            :disabled="containers.length === 1"
            @click="confirmRemove"
        >
            <Icon icon="mdi:trash-can-outline" class="w-4 h-4" />
        </button>
    </div>
</template>
