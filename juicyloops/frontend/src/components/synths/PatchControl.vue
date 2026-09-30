<script setup lang="ts">
import JuicyKnob from '@/components/ui/JuicyKnob.vue';
import { injectLearnOwner } from '@/composables/useMidiLearn';
import type { PatchParam } from '@/juicyloops/synths/params';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { computed } from 'vue';

/** One patch parameter of a synth: a knob, or a picker for a choice. */
const props = withDefaults(
    defineProps<{
        track: SynthTrack;
        param: PatchParam;
        size?: number;
        /** A shorter name than the parameter's own, where the section already says what it belongs to. */
        label?: string;
    }>(),
    { size: 46, label: undefined },
);

/** MIDI learn: the knobs belong to the track the panel shows. */
const owner = injectLearnOwner();

const value = computed(() => props.track.patch[props.param.key] ?? props.param.default);
const label = computed(() => props.label ?? props.param.label);

const pick = (event: Event) => props.track.setPatch(props.param.key, Number((event.target as HTMLSelectElement).value));
</script>

<template>
    <label v-if="props.param.options" class="patch-choice" v-tooltip.top="props.param.hint ?? null">
        <span class="patch-choice-label">{{ label }}</span>
        <select class="select select--tight" :value="Math.round(value)" :aria-label="`${props.param.group} ${props.param.label}`" @change="pick">
            <option v-for="(option, index) in props.param.options" :key="option" :value="index">{{ option }}</option>
        </select>
    </label>
    <JuicyKnob
        v-else
        :model-value="value"
        @update:model-value="props.track.setPatch(props.param.key, $event)"
        :min="props.param.min"
        :max="props.param.max"
        :step="props.param.step"
        :curve="props.param.curve"
        :format="props.param.format"
        :reset-value="props.param.default"
        :label="label"
        :hint="props.param.hint"
        :learn="owner ? { target: owner, param: props.param.key, label: `${props.param.group} ${props.param.label}` } : null"
        :size="props.size"
    />
</template>
