<script setup lang="ts">
import type { EffectDefinition, EffectKey, EffectParamKey } from '@/juicyloops/effects/definitions';
import type { Effects } from '@/juicyloops/effects/effects';
import { Icon } from '@iconify/vue';
import { computed, ref } from 'vue';
import EffectKnob from './EffectKnob.vue';

/** The knobs of one effect, with its place in the chain and the buttons to move or reset it. */
const props = defineProps<{
    effects: Effects;
    effect: EffectKey;
    definition: EffectDefinition;
    position: number;
    count: number;
    isOn: boolean;
    /** Tighter spacing for the mixer strips. */
    compact?: boolean;
}>();

const emit = defineEmits<{
    change: [];
    move: [direction: 1 | -1];
    reset: [];
}>();

/* Switches (the limiter's on/off) sit in the head as a power button, everything else is a knob. */
const knobs = computed(() => props.definition.params.filter((param) => !param.toggle));
const toggle = props.definition.params.find((param) => param.toggle);
const toggleKey = toggle?.key as EffectParamKey<typeof props.effect> | undefined;

/* The rack is not reactive, so the switch keeps its own copy; the panel is re-mounted after a reset or an undo. */
const switchedOn = ref(toggleKey ? props.effects.getParam(props.effect, toggleKey) > 0 : false);

const flip = () => {
    if (!toggleKey) {
        return;
    }
    switchedOn.value = !switchedOn.value;
    props.effects.setParam(props.effect, toggleKey, switchedOn.value ? 1 : 0);
    emit('change');
};
</script>

<template>
    <div class="device">
        <div class="device-head">
            <span class="chip-dot" :data-on="props.isOn"></span>
            <span class="device-name">{{ props.definition.label }}</span>
            <span class="device-pos">{{ props.position }} of {{ props.count }}</span>
            <button
                v-if="toggle"
                type="button"
                class="iconbtn"
                :data-active="switchedOn"
                :aria-pressed="switchedOn"
                :aria-label="`${props.definition.label} ${switchedOn ? 'on' : 'off'}`"
                v-tooltip.bottom="switchedOn ? `Turn the ${props.definition.label.toLowerCase()} off` : `Turn the ${props.definition.label.toLowerCase()} on`"
                @click="flip"
            >
                <Icon icon="mdi:power" class="w-4 h-4" />
                <span>{{ switchedOn ? 'On' : 'Off' }}</span>
            </button>
            <div class="flex-1"></div>
            <button
                type="button"
                class="iconbtn"
                :disabled="props.position === 1"
                aria-label="Move earlier in the chain"
                v-tooltip.bottom="'Move earlier in the chain'"
                @click="emit('move', -1)"
            >
                <Icon icon="mdi:arrow-left" class="w-4 h-4" />
            </button>
            <button
                type="button"
                class="iconbtn"
                :disabled="props.position === props.count"
                aria-label="Move later in the chain"
                v-tooltip.bottom="'Move later in the chain'"
                @click="emit('move', 1)"
            >
                <Icon icon="mdi:arrow-right" class="w-4 h-4" />
            </button>
            <span class="vrule"></span>
            <button type="button" class="iconbtn" v-tooltip.bottom="'Back to the default settings'" @click="emit('reset')">
                <Icon icon="mdi:restore" class="w-4 h-4" />
                <span>Reset</span>
            </button>
        </div>
        <div class="device-knobs">
            <EffectKnob
                v-for="param in knobs"
                :key="`${props.effect}-${param.key}`"
                :effects="props.effects"
                :effect="props.effect"
                :param="param"
                @change="emit('change')"
            />
        </div>
    </div>
</template>
