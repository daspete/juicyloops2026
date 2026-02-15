<template>
    <RouterView v-slot="{ Component }">
        <component :is="Component" />
    </RouterView>
    <Toast position="bottom-right" />
    <ConfirmPopup />
    <ConfirmDialog group="confirmdialog" />
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router';
import { ConfirmDialog, ConfirmPopup, Toast } from 'primevue';
</script>
