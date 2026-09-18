<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import { formatValue, paramTitle, valueAt, type AutomationCurve, type AutomationParam } from '@/juicyloops/automation';

/**
 * The head of an automation lane, the same in both views: what the lane drives (the default slot: a menu in the
 * song view, the track itself in the track view), which value, the live readout while playing, and a remove button.
 */
const props = defineProps<{
    curve: AutomationCurve;
    param?: AutomationParam;
    /** Every value the lane could drive instead. */
    parameters: readonly AutomationParam[];
    currentStep?: number | null;
}>();

const emit = defineEmits<{
    param: [key: string];
    remove: [];
}>();

const groups = computed(() => {
    const byGroup = new Map<string, AutomationParam[]>();
    for (const candidate of props.parameters) {
        byGroup.set(candidate.group, [...(byGroup.get(candidate.group) ?? []), candidate]);
    }
    return [...byGroup.entries()].map(([label, params]) => ({ label, params }));
});

/** What the lane is doing at the sounding step. */
const live = computed(() => {
    const value = props.currentStep === null || props.currentStep === undefined ? null : valueAt(props.curve.points, props.currentStep);
    return value === null ? null : props.param ? formatValue(props.param, value) : `${Math.round(value * 100)}%`;
});
</script>

<template>
    <div>
        <div class="arr-head-title">
            <span class="autolane-swatch"></span>
            <slot />
        </div>
        <div class="arr-head-title">
            <select class="select select--tight" :value="props.param?.key ?? ''" :disabled="!parameters.length" aria-label="Automated value" @change="emit('param', ($event.target as HTMLSelectElement).value)">
                <optgroup v-for="group in groups" :key="group.label" :label="group.label">
                    <option v-for="candidate in group.params" :key="candidate.key" :value="candidate.key">{{ paramTitle(candidate) }}</option>
                </optgroup>
            </select>
            <span v-if="live" class="autolane-live">{{ live }}</span>
            <div class="flex-1"></div>
            <button type="button" class="iconbtn iconbtn--tiny iconbtn--danger" aria-label="Remove automation lane" v-tooltip.bottom="'Remove lane'" @click="emit('remove')">
                <Icon icon="mdi:trash-can-outline" class="w-3.5 h-3.5" />
            </button>
        </div>
    </div>
</template>
