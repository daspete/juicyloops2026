<script setup lang="ts">
import type { EffectParamDefinition, EffectKey, EffectParamKey } from '@/juicyloops/effects/definitions';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { ref, watch } from 'vue';
import JuicyKnob from '../ui/JuicyKnob.vue';

const props = defineProps<{
    track: BaseTrack;
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
const value = ref(props.track.effects.getParam(props.effect, paramKey));

watch(value, (next) => {
    props.track.effects.setParam(props.effect, paramKey, next);
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
