<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { Slider, useToast } from 'primevue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useSampleBrowser, type AddFolderResult, type AddSampleTarget, type BrowserNode, type BrowserRoot } from '@/composables/useSampleBrowser';
import { MAX_PREVIEW_SECONDS, MIN_PREVIEW_SECONDS, useSamplePreview } from '@/composables/useSamplePreview';
import { useWorkspace } from '@/composables/useWorkspace';
import { truncateName } from '@/juicyloops/sampleFiles';
import SongMenu, { type SongMenuItem } from '../song/SongMenu.vue';

/**
 * The sample browser, docked at the far left of the stage: folders of samples as trees. A click on a sample
 * auditions it (for at most the preview length), a right-click adds it as a sampler track to the current container
 * or to a new one. The arrow keys walk the tree and audition as they go, like the browser of a DAW.
 */
const browser = useSampleBrowser();
const preview = useSamplePreview();
const { currentContainer } = useJuicyLoops();
const { isPro, toggleBrowser } = useWorkspace();
const toast = useToast();

const tree = ref<HTMLElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const isSettingsOpen = ref(false);

/** The row the keyboard is on; the one the tree focuses when tabbed into. */
const activeId = ref<string | null>(null);
const tabStop = computed(() => (browser.rows.value.some((row) => row.id === activeId.value) ? activeId.value : (browser.rows.value[0]?.id ?? null)));

const isRoot = (node: BrowserNode): node is BrowserRoot => node.depth === 0;
const isLocked = (node: BrowserNode): boolean => isRoot(node) && node.access !== 'granted';

const previewLabel = computed(() => `${preview.maxSeconds.value < 10 ? preview.maxSeconds.value.toFixed(1) : Math.round(preview.maxSeconds.value)} s`);
const volumeLabel = computed(() => `${Math.round(preview.volume.value * 100)} %`);

/* ---- adding folders ---- */

const reportFolder = (result: AddFolderResult) => {
    if (result.ok) {
        activeId.value = result.root.id;
        if (!result.isNew) {
            toast.add({ severity: 'info', summary: 'Already here', detail: result.root.name, life: 2500 });
        }
        void nextTick(() => focusRow(result.root.id));
    } else if (result.reason === 'empty') {
        toast.add({ severity: 'warn', summary: 'No samples', detail: 'That folder holds no audio files the browser can play.', life: 4000 });
    } else if (result.reason === 'error') {
        toast.add({ severity: 'error', summary: 'Could not open the folder', detail: result.error, life: 6000 });
    }
};

const addFolder = async () => {
    if (browser.canPickDirectories) {
        reportFolder(await browser.pickFolder());
    } else {
        folderInput.value?.click();
    }
};

const onFolderInput = async (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
        reportFolder(await browser.addFileList(input.files));
    }
    input.value = '';
};

/* ---- auditioning and adding samples ---- */

const audition = async (node: BrowserNode, restart = false) => {
    try {
        if (restart) {
            await preview.play(node.id, await browser.fileOf(node));
        } else {
            await preview.toggle(node.id, () => browser.fileOf(node));
        }
    } catch {
        toast.add({ severity: 'error', summary: 'Cannot play this file', detail: node.name, life: 4000 });
    }
};

const addSample = async (node: BrowserNode, target: AddSampleTarget) => {
    try {
        const container = await browser.addToContainer(node, target);
        toast.add({ severity: 'success', summary: `Added to ${container.name}`, detail: node.name, life: 2500 });
    } catch (error) {
        toast.add({ severity: 'error', summary: 'Could not add the sample', detail: error instanceof Error ? `${node.name}: ${error.message}` : node.name, life: 6000 });
    }
};

/* ---- rows ---- */

const onRowClick = async (node: BrowserNode) => {
    activeId.value = node.id;
    if (node.kind === 'file') {
        await audition(node);
    } else if (isLocked(node)) {
        await browser.requestAccess(node as BrowserRoot);
    } else {
        await browser.toggleExpanded(node);
    }
};

const focusRow = (id: string) => {
    activeId.value = id;
    tree.value?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });
};

const moveTo = (node: BrowserNode | undefined) => {
    if (!node) {
        return;
    }
    focusRow(node.id);
    if (node.kind === 'file') {
        void audition(node, true);
    }
};

/** Tree keys: up and down walk (auditioning samples), right opens or steps in, left closes or steps out. */
const onKeyDown = (event: KeyboardEvent) => {
    const rows = browser.rows.value;
    const index = rows.findIndex((row) => row.id === activeId.value);
    const node = rows[index];
    if (!node) {
        return;
    }

    let handled = true;
    switch (event.key) {
        case 'ArrowDown':
            moveTo(rows[index + 1]);
            break;
        case 'ArrowUp':
            moveTo(rows[index - 1]);
            break;
        case 'Home':
            moveTo(rows[0]);
            break;
        case 'End':
            moveTo(rows[rows.length - 1]);
            break;
        case 'ArrowRight':
            if (node.kind === 'folder' && !isLocked(node)) {
                if (!node.isExpanded) {
                    void browser.setExpanded(node, true);
                } else if (node.children?.length) {
                    moveTo(node.children[0]);
                }
            }
            break;
        case 'ArrowLeft':
            if (node.kind === 'folder' && node.isExpanded) {
                void browser.setExpanded(node, false);
            } else if (node.parentId) {
                focusRow(node.parentId);
            }
            break;
        case 'Enter':
        case ' ':
            void onRowClick(node);
            break;
        case 'Escape':
            preview.stop();
            break;
        case 'ContextMenu':
            openMenuAt(node, event.target as HTMLElement);
            break;
        default:
            handled = event.key === 'F10' && event.shiftKey ? (openMenuAt(node, event.target as HTMLElement), true) : false;
    }
    if (handled) {
        // The app's shortcuts (Space plays the song) must not fire as well.
        event.preventDefault();
        event.stopPropagation();
    }
};

/* ---- the context menu ---- */

const menu = ref<{ x: number; y: number; node: BrowserNode } | null>(null);

const openMenu = (event: MouseEvent, node: BrowserNode) => {
    activeId.value = node.id;
    menu.value = { x: event.clientX, y: event.clientY, node };
};

const openMenuAt = (node: BrowserNode, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    menu.value = { x: rect.left + 24, y: rect.bottom, node };
};

const menuItems = computed<SongMenuItem[]>(() => {
    const node = menu.value?.node;
    if (!node) {
        return [];
    }
    if (node.kind === 'file') {
        const isPlaying = preview.playingId.value === node.id;
        return [
            { label: isPlaying ? 'Stop preview' : 'Play preview', icon: isPlaying ? 'mdi:stop' : 'mdi:play', action: () => void audition(node) },
            {},
            { label: `Add to ${currentContainer.value.name}`, icon: 'mdi:playlist-plus', action: () => void addSample(node, 'current') },
            ...(isPro.value ? [{ label: 'Add to a new container', icon: 'mdi:view-grid-plus-outline', action: () => void addSample(node, 'new') }] : []),
        ];
    }

    const items: SongMenuItem[] = [];
    if (isLocked(node)) {
        items.push({ label: 'Allow access', icon: 'mdi:lock-open-variant-outline', action: () => void browser.requestAccess(node as BrowserRoot) });
    } else {
        items.push(
            { label: node.isExpanded ? 'Collapse' : 'Expand', icon: node.isExpanded ? 'mdi:chevron-up' : 'mdi:chevron-down', action: () => void browser.toggleExpanded(node) },
            { label: 'Refresh', icon: 'mdi:refresh', disabled: node.source.kind !== 'directory', action: () => void browser.load(node, true) },
        );
    }
    if (isRoot(node)) {
        items.push({}, { label: 'Remove from browser', icon: 'mdi:folder-remove-outline', danger: true, action: () => browser.removeRoot(node.id) });
    }
    return items;
});

const rowIcon = (node: BrowserNode): string => {
    if (node.kind === 'file') {
        return preview.playingId.value === node.id ? 'mdi:volume-high' : 'mdi:waveform';
    }
    if (isLocked(node)) {
        return 'mdi:folder-lock-outline';
    }
    return node.isExpanded ? 'mdi:folder-open-outline' : 'mdi:folder-outline';
};

onMounted(() => void browser.restore());
onBeforeUnmount(() => preview.stop());
</script>

<template>
    <aside class="dock dock--browser" aria-label="Sample browser">
        <header class="dock-bar">
            <Icon icon="mdi:folder-music-outline" class="w-4 h-4" />
            <span class="dock-title">Samples</span>
            <div class="flex-1"></div>
            <button type="button" class="iconbtn" aria-label="Add a folder" v-tooltip.bottom="'Add a folder of samples'" @click="addFolder">
                <Icon icon="mdi:folder-plus-outline" class="w-4 h-4" />
            </button>
            <button
                type="button"
                class="iconbtn"
                :data-active="isSettingsOpen"
                :aria-pressed="isSettingsOpen"
                aria-label="Preview settings"
                v-tooltip.bottom="'Preview length and level'"
                @click="isSettingsOpen = !isSettingsOpen"
            >
                <Icon icon="mdi:tune-variant" class="w-4 h-4" />
            </button>
            <button type="button" class="iconbtn" aria-label="Close sample browser" v-tooltip.bottom="'Close (B)'" @click="toggleBrowser">
                <Icon icon="mdi:close" class="w-4 h-4" />
            </button>
        </header>

        <div v-if="isSettingsOpen" class="sb-settings">
            <label class="sb-setting">
                <span class="sb-setting-label">Preview up to</span>
                <Slider v-model="preview.maxSeconds.value" :min="MIN_PREVIEW_SECONDS" :max="MAX_PREVIEW_SECONDS" :step="0.5" class="sb-setting-slider" aria-label="Longest preview in seconds" />
                <span class="sb-setting-value">{{ previewLabel }}</span>
            </label>
            <label class="sb-setting">
                <span class="sb-setting-label">Level</span>
                <Slider v-model="preview.volume.value" :min="0" :max="1" :step="0.01" class="sb-setting-slider" aria-label="Preview level" />
                <span class="sb-setting-value">{{ volumeLabel }}</span>
            </label>
        </div>

        <input ref="folderInput" type="file" class="hidden" webkitdirectory multiple @change="onFolderInput" />

        <div v-if="browser.isRestored.value && !browser.roots.length" class="sb-empty">
            <Icon icon="mdi:folder-music-outline" class="w-8 h-8" />
            <p>Add folders with your samples. Click a sample to hear it, right-click it to add it as a track.</p>
            <button type="button" class="chip chip--juice" style="--jl-accent: var(--jl-sampler)" @click="addFolder">
                <Icon icon="mdi:folder-plus-outline" class="w-4 h-4" />
                <span>Add a folder</span>
            </button>
            <p v-if="!browser.canPickDirectories" class="sb-empty-note">This browser forgets the folders when you leave; Chrome and Edge remember them.</p>
        </div>

        <div v-else ref="tree" class="sb-tree" role="tree" aria-label="Sample folders" @keydown="onKeyDown">
            <div
                v-for="row in browser.rows.value"
                :key="row.id"
                :data-id="row.id"
                class="sb-row"
                role="treeitem"
                :data-kind="row.kind"
                :data-root="row.depth === 0"
                :data-active="activeId === row.id"
                :data-playing="preview.playingId.value === row.id"
                :aria-level="row.depth + 1"
                :aria-expanded="row.kind === 'folder' ? row.isExpanded : undefined"
                :aria-selected="activeId === row.id"
                :tabindex="tabStop === row.id ? 0 : -1"
                :title="row.kind === 'file' ? `${row.name}\nClick to hear it, right-click to add it as a track` : row.name"
                :style="{ '--sb-depth': row.depth }"
                @click="onRowClick(row)"
                @focus="activeId = row.id"
                @contextmenu.prevent="openMenu($event, row)"
            >
                <Icon
                    v-if="row.kind === 'folder'"
                    :icon="row.isLoading ? 'mdi:loading' : 'mdi:chevron-right'"
                    class="sb-chevron"
                    :class="{ 'animate-spin': row.isLoading }"
                    :data-open="row.isExpanded"
                />
                <span v-else class="sb-chevron"></span>
                <Icon :icon="rowIcon(row)" class="sb-icon" />
                <span class="sb-name">{{ truncateName(row.name, row.kind) }}</span>
                <span v-if="isRoot(row) && !row.isPersistent" class="sb-tag" v-tooltip.bottom="'Forgotten when you leave the page'">visit</span>
                <button v-if="isLocked(row)" type="button" class="sb-allow" tabindex="-1" @click.stop="browser.requestAccess(row as BrowserRoot)">Allow</button>
                <button
                    v-else-if="row.kind === 'file'"
                    type="button"
                    class="sb-add"
                    tabindex="-1"
                    :aria-label="`Add ${row.name} to ${currentContainer.name}`"
                    v-tooltip.bottom="{ value: `Add to ${currentContainer.name}`, showDelay: 400 }"
                    @click.stop="addSample(row, 'current')"
                >
                    <Icon icon="mdi:plus" class="w-3.5 h-3.5" />
                </button>
                <span
                    v-if="preview.playingId.value === row.id && preview.playingSeconds.value > 0"
                    :key="preview.playCount.value"
                    class="sb-progress"
                    :style="{ animationDuration: `${preview.playingSeconds.value}s` }"
                    aria-hidden="true"
                ></span>
                <span v-if="row.error" class="sb-error" :title="row.error"><Icon icon="mdi:alert-circle-outline" class="w-3.5 h-3.5" /></span>
            </div>
        </div>

        <SongMenu v-if="menu" :items="menuItems" :x="menu.x" :y="menu.y" :title="menu.node.name" @close="menu = null" />
    </aside>
</template>
