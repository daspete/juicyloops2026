<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useVelocityTool, VELOCITY_TOOLS } from './useVelocityTool';

/** The tool switch of the velocity lanes (shared by all of them) and the ⋯ button that opens a lane's commands. */
const emit = defineEmits<{
    menu: [event: MouseEvent];
}>();

const { tool } = useVelocityTool();
</script>

<template>
    <div class="velo-tools" role="group" aria-label="Velocity tools">
        <div class="velo-toolswitch" role="radiogroup" aria-label="Velocity tool">
            <button
                v-for="item in VELOCITY_TOOLS"
                :key="item.key"
                type="button"
                class="velo-toolbtn"
                role="radio"
                :aria-checked="tool === item.key"
                :data-active="tool === item.key"
                :aria-label="item.label"
                v-tooltip.bottom="{ value: item.hint, showDelay: 400 }"
                @click="tool = item.key"
            >
                <Icon :icon="item.icon" class="w-4 h-4" />
                <span class="velo-toolbtn-label">{{ item.label }}</span>
            </button>
        </div>
        <button
            type="button"
            class="iconbtn iconbtn--tiny"
            aria-label="Velocity commands"
            aria-haspopup="menu"
            v-tooltip.bottom="'Humanize, randomize, ramps, accents (also on a right-click in the lane)'"
            @click="emit('menu', $event)"
        >
            <Icon icon="mdi:dots-horizontal" class="w-4 h-4" />
        </button>
    </div>
</template>
