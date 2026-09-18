<script setup lang="ts">
import type { EffectDefinition, EffectKey } from '@/juicyloops/effects/definitions';
import type { Effects } from '@/juicyloops/effects/effects';
import { Icon } from '@iconify/vue';
import EffectKnob from './EffectKnob.vue';

/** The knobs of one effect, with its place in the chain and the buttons to move or reset it. */
const props = defineProps<{
    effects: Effects;
    effect: EffectKey;
    definition: EffectDefinition;
    position: number;
    count: number;
    isOn: boolean;
}>();

const emit = defineEmits<{
    change: [];
    move: [direction: 1 | -1];
    reset: [];
}>();
</script>

<template>
    <div class="rounded-xl bg-(--jl-cell) overflow-hidden">
        <div class="flex items-center gap-2 px-3 h-9 border-b border-(--jl-line)">
            <span class="chip-dot" :data-on="props.isOn"></span>
            <span class="font-semibold">{{ props.definition.label }}</span>
            <span class="font-mono text-xs text-(--jl-muted)">{{ props.position }} of {{ props.count }}</span>
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
            <span class="w-px h-4 bg-(--jl-line) mx-1"></span>
            <button type="button" class="iconbtn" v-tooltip.bottom="'Back to the default settings'" @click="emit('reset')">
                <Icon icon="mdi:restore" class="w-4 h-4" />
                <span>Reset</span>
            </button>
        </div>
        <div class="flex flex-wrap gap-x-7 gap-y-3 px-4 py-3">
            <EffectKnob
                v-for="param in props.definition.params"
                :key="`${props.effect}-${param.key}`"
                :effects="props.effects"
                :effect="props.effect"
                :param="param"
                @change="emit('change')"
            />
        </div>
    </div>
</template>
