<script setup lang="ts">
/**
 * A piece of text that changes often (a play position), in a component of its own: when it changes, only this text
 * node re-renders, not the big template around it. `text` is a getter, so the parent's render never reads the value.
 */
const props = defineProps<{
    text: () => string;
}>();
</script>

<template>{{ props.text() }}</template>
