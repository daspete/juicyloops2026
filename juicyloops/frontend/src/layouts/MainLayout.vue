<script setup lang="ts">
/* The studio stylesheet only ships with the studio; the marketing pages stay light. */
import '@/assets/css/globals.css';
import '@/assets/css/velocity.css';
import '@/assets/css/studio-rack.css';
import JuicyLoops from '@/components/JuicyLoops.vue';
import { ConfirmDialog, ConfirmPopup, Toast } from 'primevue';
</script>

<template>
    <div class="h-full w-full">
        <JuicyLoops />
    </div>
    <Toast position="bottom-right" />
    <ConfirmPopup />
    <ConfirmDialog group="confirmdialog" />
</template>
