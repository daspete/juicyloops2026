<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { MODEL_META, SYNTH_MODELS, type SynthModel } from '@/juicyloops/synths/params';

/** Which synth engine a synth track plays: one button per model. */
const props = defineProps<{
    model: SynthModel;
}>();

const emit = defineEmits<{
    pick: [model: SynthModel];
}>();
</script>

<template>
    <div class="segmented synth-models" role="radiogroup" aria-label="Synth engine">
        <button
            v-for="model in SYNTH_MODELS"
            :key="model"
            type="button"
            role="radio"
            :aria-checked="props.model === model"
            :data-active="props.model === model"
            v-tooltip.top="MODEL_META[model].blurb"
            @click="emit('pick', model)"
        >
            <Icon :icon="MODEL_META[model].icon" class="w-3.5 h-3.5" />
            <span>{{ MODEL_META[model].label }}</span>
        </button>
    </div>
</template>
