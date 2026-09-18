<script setup lang="ts">
import { formatValue, paramTitle, type AutomationParam, type StepAutomationLane } from '@/juicyloops/automation';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import StepValueLane from './StepValueLane.vue';

/**
 * The automation track of one track: one lane per automated value, a bar per step, looping with the pattern.
 * Any parameter of the track can be drawn here: level, pan, the synth envelope, every effect knob.
 * A new lane starts flat at the value's current setting, so nothing changes until you draw.
 */
const props = defineProps<{
    track: BaseTrack;
}>();

const emit = defineEmits<{
    close: [];
}>();

/** The parameters grouped the way the menus show them: Mix, the track's own, then one group per effect. */
const groups = computed(() => {
    const byGroup = new Map<string, AutomationParam[]>();
    for (const param of props.track.parameters) {
        byGroup.set(param.group, [...(byGroup.get(param.group) ?? []), param]);
    }
    return [...byGroup.entries()].map(([label, params]) => ({ label, params }));
});

const paramOf = (lane: StepAutomationLane): AutomationParam | undefined => props.track.parameter(lane.param);

const add = (event: Event) => {
    const select = event.target as HTMLSelectElement;
    if (select.value) {
        props.track.addAutomation(select.value);
    }
    select.value = '';
};

const retarget = (lane: StepAutomationLane, event: Event) => {
    lane.param = (event.target as HTMLSelectElement).value;
};

const set = (lane: StepAutomationLane, index: number, value: number) => {
    lane.values[index] = value;
};

const format = (lane: StepAutomationLane) => (value: number, index: number) => {
    const param = paramOf(lane);
    return `Step ${index + 1}: ${param ? formatValue(param, value) : Math.round(value * 100) + '%'}`;
};

/** A flat lane back at the value's current setting. */
const flatten = (lane: StepAutomationLane) => {
    const param = paramOf(lane);
    if (param) {
        const current = props.track.addAutomation(lane.param);
        lane.values.fill(current === lane ? lane.values[0]! : 0.5);
    }
};

const remove = (lane: StepAutomationLane) => {
    props.track.automation.remove(lane.id);
    if (!props.track.automation.lanes.length) {
        emit('close');
    }
};

/** Spreads the lanes over the hue wheel, so several lanes under one track are told apart at a glance. */
const hue = (index: number) => 200 + index * 47;
</script>

<template>
    <div class="lane-stack automation">
        <div v-for="(lane, index) in props.track.automation.lanes" :key="lane.id" class="autolane" :style="{ '--jl-auto': `oklch(0.75 0.16 ${hue(index)})` }">
            <div class="autolane-head">
                <span class="autolane-swatch"></span>
                <select class="select" :value="lane.param" aria-label="Automated value" @change="retarget(lane, $event)">
                    <optgroup v-for="group in groups" :key="group.label" :label="group.label">
                        <option v-for="param in group.params" :key="param.key" :value="param.key">{{ paramTitle(param) }}</option>
                    </optgroup>
                </select>
                <span class="autolane-range">
                    <span>{{ paramOf(lane) ? formatValue(paramOf(lane)!, 0) : '' }}</span>
                    <Icon icon="mdi:arrow-right-thin" class="w-4 h-4" />
                    <span>{{ paramOf(lane) ? formatValue(paramOf(lane)!, 1) : '' }}</span>
                </span>
                <div class="flex-1"></div>
                <button type="button" class="iconbtn iconbtn--tiny" v-tooltip.bottom="'Flatten the lane'" aria-label="Flatten the lane" @click="flatten(lane)">
                    <Icon icon="mdi:minus" class="w-3.5 h-3.5" />
                </button>
                <button type="button" class="iconbtn iconbtn--tiny iconbtn--danger" v-tooltip.bottom="'Remove lane'" aria-label="Remove lane" @click="remove(lane)">
                    <Icon icon="mdi:trash-can-outline" class="w-3.5 h-3.5" />
                </button>
            </div>
            <StepValueLane :values="lane.values" :format="format(lane)" @set="(step, value) => set(lane, step, value)" />
        </div>

        <div class="lane-foot">
            <select class="select select--add" aria-label="Add an automation lane" @change="add">
                <option value="">+ Automate a value…</option>
                <optgroup v-for="group in groups" :key="group.label" :label="group.label">
                    <option v-for="param in group.params" :key="param.key" :value="param.key">{{ paramTitle(param) }}</option>
                </optgroup>
            </select>
            <span class="lane-hint">{{
                props.track.automation.lanes.length ? 'Drag across the bars to draw the value for every step. It loops with the pattern.' : 'Pick a value to draw over the loop: level, pan, an effect knob, the envelope.'
            }}</span>
            <div class="flex-1"></div>
            <button v-if="!props.track.automation.lanes.length" type="button" class="iconbtn iconbtn--tiny" aria-label="Close" @click="emit('close')">
                <Icon icon="mdi:close" class="w-3.5 h-3.5" />
            </button>
        </div>
    </div>
</template>
