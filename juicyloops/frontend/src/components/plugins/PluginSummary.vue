<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import { pluginStatus } from '@/juicyloops/plugins/pluginStatus';

/** A plugin in a device card: its name and maker, whether it loaded, and buttons to open its window or change it. */
const props = defineProps<{
    /** Its key in `pluginStatus`. */
    owner: string;
    name: string;
    vendor?: string;
    /** Label of the change button; none hides it. */
    changeLabel?: string;
}>();

const emit = defineEmits<{
    open: [];
    change: [];
}>();

const status = computed(() => pluginStatus(props.owner));
const title = computed(() => (status.value?.state === 'ready' ? status.value.name : props.name));
const vendor = computed(() => (status.value?.state === 'ready' ? status.value.vendor : props.vendor));
</script>

<template>
    <div class="plugin-summary" :data-state="status?.state ?? 'idle'">
        <div class="plugin-summary-name">
            <Icon icon="mdi:puzzle-outline" class="w-5 h-5 shrink-0" />
            <span class="min-w-0">
                <strong>{{ title }}</strong>
                <small v-if="vendor">{{ vendor }}</small>
            </span>
        </div>
        <p v-if="status?.state === 'loading'" class="plugin-empty"><Icon icon="mdi:loading" class="w-4 h-4 animate-spin" /> Loading…</p>
        <p v-else-if="status?.state === 'error'" class="plugin-error">{{ status.message }}</p>
        <div class="plugin-summary-actions">
            <button type="button" class="iconbtn" :disabled="status?.state !== 'ready'" @click="emit('open')">
                <Icon icon="mdi:open-in-new" class="w-4 h-4" />
                <span>Open</span>
            </button>
            <button v-if="props.changeLabel" type="button" class="iconbtn" @click="emit('change')">
                <Icon icon="mdi:swap-horizontal" class="w-4 h-4" />
                <span>{{ props.changeLabel }}</span>
            </button>
        </div>
    </div>
</template>
