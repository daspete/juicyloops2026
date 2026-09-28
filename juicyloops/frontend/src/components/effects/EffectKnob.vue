<script setup lang="ts">
import { injectLearnOwner } from '@/composables/useMidiLearn';
import type { EffectParamDefinition, EffectKey, EffectParamKey } from '@/juicyloops/effects/definitions';
import { effectParamKey, type Effects } from '@/juicyloops/effects/effects';
import { computed, ref, watch } from 'vue';
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

/* MIDI learn: the rack's owner (a track, a bus) comes from the panel around it. */
const owner = injectLearnOwner();
const learn = computed(() => (owner.value && props.param.automatable !== false ? { target: owner.value, param: effectParamKey(props.effect, props.param.key) } : null));
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
        :learn="learn"
        :size="60"
    />
</template>
