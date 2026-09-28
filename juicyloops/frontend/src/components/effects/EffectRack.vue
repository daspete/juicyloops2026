<script setup lang="ts">
import { EFFECT_DEFINITIONS, type EffectKey } from '@/juicyloops/effects/definitions';
import type { Effects } from '@/juicyloops/effects/effects';
import { Icon } from '@iconify/vue';
import { computed, ref } from 'vue';
import EffectPanel from './EffectPanel.vue';

/**
 * One effect chain (of a track, a container bus or the master), shown in signal order from the input to the output.
 * Chips can be dragged to reorder the chain, the chosen effect's knobs sit below.
 * A lit dot on a chip means that effect is doing something to the sound.
 * `compact` stacks the chain top to bottom, for the narrow strips of the mixer.
 */
const props = defineProps<{
    effects: Effects;
    compact?: boolean;
}>();

/* The Effects instance is not reactive (it owns Tone nodes), so the rack keeps reactive mirrors of what it shows. */
const order = ref<EffectKey[]>([...props.effects.order]);
const selected = ref<EffectKey>(order.value.includes('reverb') ? 'reverb' : order.value[0]!);
/** Bumped after a reset so the knobs re-read their values. */
const version = ref(0);

/**
 * An effect counts as "on" when it changes the sound: a mixable effect once it is not fully dry, a dynamics stage
 * once it is not neutral (compressor above 1:1, EQ not flat, limiter switched on). The rack builds its node by the same rule.
 */
const isOn = (effect: EffectKey): boolean => props.effects.isNeeded(effect);

const active = ref(new Set(order.value.filter(isOn)));
const refresh = () => (active.value = new Set(order.value.filter(isOn)));

const selectedIndex = computed(() => order.value.indexOf(selected.value));

const syncOrder = () => (order.value = [...props.effects.order]);

const move = (direction: 1 | -1) => {
    props.effects.move(selected.value, direction);
    syncOrder();
};

const reset = () => {
    props.effects.reset(selected.value);
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
    props.effects.setOrder(next);
    syncOrder();
};

const onDragEnd = () => {
    dragging.value = null;
    dropTarget.value = null;
};
</script>

<template>
    <div class="rack" :class="{ 'rack--compact': props.compact }">
        <div class="chain">
            <span class="chain-end"><Icon icon="mdi:volume-source" class="w-4 h-4" /> in</span>
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
                    <span class="chip-index">{{ index + 1 }}</span>
                    <span>{{ EFFECT_DEFINITIONS[key].label }}</span>
                </button>
                <Icon v-if="index < order.length - 1" icon="mdi:chevron-right" class="chain-arrow" />
            </template>
            <span class="chain-end">out <Icon icon="mdi:speaker" class="w-4 h-4" /></span>
        </div>

        <EffectPanel
            :key="`${selected}-${version}`"
            :effects="props.effects"
            :effect="selected"
            :definition="EFFECT_DEFINITIONS[selected]"
            :position="selectedIndex + 1"
            :count="order.length"
            :is-on="active.has(selected)"
            :compact="props.compact"
            @change="refresh"
            @move="move"
            @reset="reset"
        />
    </div>
</template>
