<script setup lang="ts">
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
