<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, ref } from 'vue';
import { channelOf } from '@/composables/useChannels';
import { useViewport } from '@/composables/useViewport';
import { DOCK_MIN_HEIGHT, useWorkspace, type DockTab } from '@/composables/useWorkspace';
import DeviceRack from '../devices/DeviceRack.vue';
import MixerRack from '../mixer/MixerRack.vue';

/**
 * The bottom dock: Devices (the selected channel's chain) and Mixer (every channel), one tab at a time, like the detail
 * view of a DAW. Drag its top edge to resize; maximise it to fill the workspace while mixing; collapse it to its tab
 * bar. On a phone it is a sheet over the whole stage.
 */
const { dock, isDockOpen, dockTab, openDock, toggleDock, closeDock, setDockHeight, toggleDockMaximized, selectedChannel } = useWorkspace();
const { isPhone } = useViewport();

const TABS: readonly { key: DockTab; label: string; icon: string; key_: string; hint: string }[] = [
    { key: 'devices', label: 'Devices', icon: 'mdi:tune-variant', key_: 'D', hint: 'The instrument and effects of the selected channel' },
    { key: 'mixer', label: 'Mixer', icon: 'mdi:tune-vertical', key_: 'M', hint: 'Every channel: levels, pan, sends, mute and solo' },
];

const channelName = computed(() => (selectedChannel.value ? channelOf(selectedChannel.value)?.name : null) ?? '');

const style = computed(() => (isPhone.value || dock.value.maximized || !isDockOpen.value ? {} : { height: `${dock.value.height}px` }));

/* ---- resizing by the top edge ---- */

const isResizing = ref(false);
let start: { y: number; height: number; pointerId: number } | null = null;

const onGripDown = (event: PointerEvent) => {
    if (event.button !== 0 || dock.value.maximized) {
        return;
    }
    event.preventDefault();
    start = { y: event.clientY, height: dock.value.height, pointerId: event.pointerId };
    isResizing.value = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};

const onGripMove = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.pointerId) {
        return;
    }
    const max = window.innerHeight - 180;
    setDockHeight(Math.min(max, Math.max(DOCK_MIN_HEIGHT, start.height + (start.y - event.clientY))));
};

const onGripUp = () => {
    start = null;
    isResizing.value = false;
};

const onGripKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        setDockHeight(dock.value.height + (event.key === 'ArrowUp' ? 24 : -24));
    }
};
</script>

<template>
    <section
        class="bdock"
        :class="{ 'bdock--open': isDockOpen, 'bdock--max': isDockOpen && dock.maximized, 'bdock--resizing': isResizing, 'bdock--sheet': isPhone && isDockOpen }"
        :style="style"
        aria-label="Devices and mixer"
    >
        <div
            v-if="isDockOpen && !isPhone && !dock.maximized"
            class="bdock-grip"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the dock"
            tabindex="0"
            @pointerdown="onGripDown"
            @pointermove="onGripMove"
            @pointerup="onGripUp"
            @pointercancel="onGripUp"
            @keydown="onGripKey"
            @dblclick="toggleDockMaximized"
        ></div>
        <header class="bdock-bar">
            <div class="bdock-tabs" role="tablist" aria-label="Dock">
                <button
                    v-for="tab in TABS"
                    :key="tab.key"
                    type="button"
                    role="tab"
                    class="bdock-tab"
                    :data-active="isDockOpen && dockTab === tab.key"
                    :aria-selected="isDockOpen && dockTab === tab.key"
                    v-tooltip.top="{ value: `${tab.hint} (${tab.key_})`, showDelay: 500 }"
                    @click="isDockOpen && dockTab === tab.key ? closeDock() : openDock(tab.key)"
                >
                    <Icon :icon="tab.icon" class="w-4 h-4" />
                    <span>{{ tab.label }}</span>
                    <kbd v-if="!isPhone">{{ tab.key_ }}</kbd>
                </button>
            </div>
            <span v-if="channelName" class="bdock-scope">
                <Icon icon="mdi:target" class="w-3.5 h-3.5" />
                {{ channelName }}
            </span>
            <div class="flex-1"></div>
            <button v-if="isDockOpen && !isPhone" type="button" class="iconbtn" :aria-label="dock.maximized ? 'Restore the dock' : 'Maximise the dock'" v-tooltip.top="dock.maximized ? 'Back to its size' : 'Fill the workspace'" @click="toggleDockMaximized">
                <Icon :icon="dock.maximized ? 'mdi:arrow-collapse-vertical' : 'mdi:arrow-expand-vertical'" class="w-4 h-4" />
            </button>
            <button type="button" class="iconbtn" :aria-label="isDockOpen ? 'Collapse the dock' : 'Open the dock'" v-tooltip.top="isDockOpen ? 'Collapse' : 'Open'" @click="toggleDock()">
                <Icon :icon="isDockOpen ? 'mdi:chevron-down' : 'mdi:chevron-up'" class="w-4 h-4" />
            </button>
        </header>
        <div v-if="isDockOpen" class="bdock-body">
            <!-- No KeepAlive: a hidden tab's meters must go, so a closed mixer costs nothing. -->
            <DeviceRack v-if="dockTab === 'devices'" />
            <MixerRack v-else />
        </div>
    </section>
</template>
