<script setup lang="ts">
import type { EffectParamDefinition, EffectKey, EffectParamKey } from '@/juicyloops/effects/definitions';
import type { Effects } from '@/juicyloops/effects/effects';
import { ref, watch } from 'vue';
import JuicyKnob from '../ui/JuicyKnob.vue';

const props = defineProps<{
    effects: Effects;
    effect: EffectKey;
    param: EffectParamDefinition;
}>();

const emit = defineEmits<{
    change: [];
}>();

const paramKey = props.param.key as EffectParamKey<typeof props.effect>;

/*
 * Tone parameters are not reactive, so the knob keeps its own value:
 * read once when mounted and written through to the audio node on every change.
 */
const value = ref(props.effects.getParam(props.effect, paramKey));

watch(value, (next) => {
    props.effects.setParam(props.effect, paramKey, next);
    emit('change');
});
</script>

<template>
    <JuicyKnob
        v-model="value"
        :min="props.param.min"
        :max="props.param.max"
        :step="props.param.step"
        :curve="props.param.curve"
        :label="props.param.label"
        :format="props.param.format"
        :size="60"
    />
</template>
