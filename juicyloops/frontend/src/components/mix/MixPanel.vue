<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useHistory } from '@/composables/useHistory';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import BusStrip from './BusStrip.vue';

/**
 * The mixer, docked to the right of the workspace: the channel of the current container and the master,
 * in signal order from top to bottom. Every track sums into the container channel, every container into the master.
 * The tracks' own effects live in the detail panel below the workspace; these two racks sit apart on purpose.
 */
const { engine, currentContainer } = useJuicyLoops();
const { toggleMixer } = useWorkspace();
const { version } = useHistory();
</script>

<template>
    <aside class="dock dock--right" aria-label="Mixer">
        <header class="dock-bar">
            <Icon icon="mdi:tune-vertical" class="w-4 h-4" />
            <span class="dock-title">Mixer</span>
            <span class="dock-note">Tracks sum into the container, containers into the master.</span>
            <div class="flex-1"></div>
            <button type="button" class="iconbtn" aria-label="Close mixer" v-tooltip.bottom="'Close'" @click="toggleMixer">
                <Icon icon="mdi:close" class="w-4 h-4" />
            </button>
        </header>
        <div class="dock-body">
            <BusStrip
                :key="`${currentContainer.id}-${version}`"
                :bus="currentContainer.bus"
                :name="currentContainer.name"
                kind="Container channel"
                icon="mdi:view-grid-outline"
                note="Every track in this container runs through here before the master."
                accent="var(--jl-brand)"
            />
            <div class="mixer-flow" aria-hidden="true">
                <Icon icon="mdi:arrow-down" class="w-4 h-4" />
            </div>
            <BusStrip :key="`master-${version}`" :bus="engine.master" name="Master" kind="Master channel" icon="mdi:speaker" note="Everything you hear passes through here last." accent="var(--jl-brand-2)" />
        </div>
    </aside>
</template>
