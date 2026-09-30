<script setup lang="ts">
import { usePlugins } from '@/composables/usePlugins';
import PluginWindow from './PluginWindow.vue';

/** Every open plugin window, the last opened (or touched) on top. */
const { windows } = usePlugins();
</script>

<template>
    <Teleport to="body">
        <PluginWindow v-for="(entry, index) in windows" :key="entry.key" :entry="entry" :index="index" :style="{ zIndex: 900 + index }" />
    </Teleport>
</template>
