<script setup lang="ts">
import { EFFECT_DEFINITIONS, type EffectKey, type EffectParamKey } from '@/juicyloops/effects/definitions';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';
import { computed, ref } from 'vue';
import EffectPanel from './EffectPanel.vue';

/**
 * The effect chain of one track, shown in signal order from the sound source to the output.
 * Chips can be dragged to reorder the chain, the chosen effect's knobs sit below.
 * A lit dot on a chip means that effect is doing something to the sound.
 */
const props = defineProps<{
    track: BaseTrack;
}>();

/* The Effects instance is not reactive (it owns Tone nodes), so the rack keeps reactive mirrors of what it shows. */
const order = ref<EffectKey[]>([...props.track.effects.order]);
const selected = ref<EffectKey>(order.value.includes('reverb') ? 'reverb' : order.value[0]!);
/** Bumped after a reset so the knobs re-read their values. */
const version = ref(0);

const read = (effect: EffectKey, param: string) => props.track.effects.getParam(effect, param as EffectParamKey<typeof effect>);

/** Effects that are always in the chain (dynamics/EQ) count as "on" once they deviate from neutral. */
const isOn = (effect: EffectKey): boolean => {
    const params = EFFECT_DEFINITIONS[effect].params;
    if (params.some((param) => param.key === 'wet')) {
        return read(effect, 'wet') > 0;
    }
    if (effect === 'equalizer') {
        return params.some((param) => read(effect, param.key) !== 0);
    }
    return false;
};

const active = ref(new Set(order.value.filter(isOn)));
const refresh = () => (active.value = new Set(order.value.filter(isOn)));

const selectedIndex = computed(() => order.value.indexOf(selected.value));

const syncOrder = () => (order.value = [...props.track.effects.order]);

const move = (direction: 1 | -1) => {
    props.track.effects.move(selected.value, direction);
    syncOrder();
};

const reset = () => {
    props.track.effects.reset(selected.value);
    version.value++;
    refresh();
};

/* ---- drag to reorder ---- */

const dragging = ref<EffectKey | null>(null);
const dropTarget = ref<EffectKey | null>(null);

const onDragStart = (event: DragEvent, effect: EffectKey) => {
    dragging.value = effect;
    event.dataTransfer?.setData('text/plain', effect);
    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
    }
};

const onDrop = (target: EffectKey) => {
    const source = dragging.value;
    dragging.value = null;
    dropTarget.value = null;
    if (!source || source === target) {
        return;
    }

    const next = order.value.filter((key) => key !== source);
    next.splice(next.indexOf(target), 0, source);
    props.track.effects.setOrder(next);
    syncOrder();
};

const onDragEnd = () => {
    dragging.value = null;
    dropTarget.value = null;
};
</script>

<template>
    <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-xs text-(--jl-muted) mr-1 flex items-center gap-1"><Icon icon="mdi:volume-source" class="w-4 h-4" /> in</span>
            <template v-for="(key, index) in order" :key="key">
                <button
                    type="button"
                    class="chip chip--draggable"
                    :data-active="selected === key"
                    :data-dragging="dragging === key"
                    :data-drop="dropTarget === key"
                    :aria-pressed="selected === key"
                    draggable="true"
                    v-tooltip.bottom="{ value: 'Drag to change the order', showDelay: 800 }"
                    @click="selected = key"
                    @dragstart="onDragStart($event, key)"
                    @dragover.prevent="dropTarget = key"
                    @dragleave="dropTarget === key && (dropTarget = null)"
                    @drop.prevent="onDrop(key)"
                    @dragend="onDragEnd"
                >
                    <span class="chip-dot" :data-on="active.has(key)"></span>
                    <span class="font-mono text-[0.65rem] text-(--jl-muted)">{{ index + 1 }}</span>
                    <span>{{ EFFECT_DEFINITIONS[key].label }}</span>
                </button>
                <Icon v-if="index < order.length - 1" icon="mdi:chevron-right" class="w-3.5 h-3.5 text-(--jl-line) -mx-1" />
            </template>
            <span class="text-xs text-(--jl-muted) ml-1 flex items-center gap-1">out <Icon icon="mdi:speaker" class="w-4 h-4" /></span>
        </div>

        <EffectPanel
            :key="`${selected}-${version}`"
            :track="props.track"
            :effect="selected"
            :definition="EFFECT_DEFINITIONS[selected]"
            :position="selectedIndex + 1"
            :count="order.length"
            :is-on="active.has(selected)"
            @change="refresh"
            @move="move"
            @reset="reset"
        />
    </div>
</template>
