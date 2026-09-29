<script setup lang="ts">
import { injectLearnOwner } from '@/composables/useMidiLearn';
import type { EffectParamDefinition } from '@/juicyloops/effects/definitions';
import { effectParamKey, type Effects } from '@/juicyloops/effects/effects';
import { computed, ref, watch } from 'vue';
import JuicyKnob from '../ui/JuicyKnob.vue';

/** One parameter of an effect slot as a knob. `label` overrides the parameter's own name (the macro face's words). */
const props = defineProps<{
    effects: Effects;
    slotId: string;
    param: EffectParamDefinition;
    label?: string;
    size?: number;
}>();

const emit = defineEmits<{
    change: [];
}>();

/*
 * The rack is not reactive, so the knob keeps its own value: read once when mounted and written through to the audio
 * node on every change. The device re-mounts its knobs after an undo, a reset or a preset.
 */
const value = ref(props.effects.getParam(props.slotId, props.param.key));

watch(value, (next) => {
    props.effects.setParam(props.slotId, props.param.key, next);
    emit('change');
});

/* MIDI learn: the rack's owner (a track, a bus) comes from the panel around it. */
const owner = injectLearnOwner();
const learn = computed(() => (owner.value && props.param.automatable !== false ? { target: owner.value, param: effectParamKey(props.slotId, props.param.key) } : null));
</script>

<template>
    <JuicyKnob
        v-model="value"
        :min="props.param.min"
        :max="props.param.max"
        :step="props.param.step"
        :curve="props.param.curve"
        :label="props.label ?? props.param.label"
        :format="props.param.format"
        :learn="learn"
        :size="props.size ?? 52"
    />
</template>
