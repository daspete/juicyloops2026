<script setup lang="ts">
import { paramTitle, type AutomationParam, type StepAutomationLane } from '@/juicyloops/automation';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import AutomationCurve from '@/components/ui/AutomationCurve.vue';
import AutomationLaneHead from '@/components/ui/AutomationLaneHead.vue';
import { BEAT_SIZE } from '../steps';
import { TRACK_META } from '../trackMeta';

/**
 * The automation track of one track: one lane per automated value, a curve over the loop, drawn and edited
 * exactly like the lanes of the song view. Any parameter of the track can be drawn here: level, pan,
 * the synth envelope, every effect knob. A new lane starts flat at the value's current setting.
 */
const props = defineProps<{
    track: BaseTrack;
}>();

const emit = defineEmits<{
    close: [];
}>();

const { trackStep, isPlaying, tracks } = useJuicyLoops();

const meta = computed(() => TRACK_META[props.track.type]);
const trackName = computed(() => `${meta.value.label} ${tracks.value.indexOf(props.track) + 1}`);
const currentStep = computed(() => (isPlaying.value ? trackStep(props.track) : null));

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

const retarget = (lane: StepAutomationLane, key: string) => {
    props.track.settle(lane.param);
    lane.param = key;
};

const remove = (lane: StepAutomationLane) => {
    props.track.automation.remove(lane.id);
    props.track.settle(lane.param);
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
            <AutomationLaneHead
                class="autolane-head"
                :curve="lane"
                :param="paramOf(lane)"
                :parameters="props.track.parameters"
                :current-step="currentStep"
                @param="retarget(lane, $event)"
                @remove="remove(lane)"
            >
                <span class="autolane-target"><Icon :icon="meta.icon" class="w-3.5 h-3.5" /> {{ trackName }}</span>
            </AutomationLaneHead>
            <AutomationCurve
                class="autolane-body"
                :style="{ '--jl-auto-steps': props.track.length, '--jl-auto-beats': Math.ceil(props.track.length / BEAT_SIZE) }"
                :curve="lane"
                :total-steps="props.track.length"
                :snap="1"
                :param="paramOf(lane)"
                :hint="lane.points.length ? '' : 'Click to place the first point'"
            />
        </div>

        <div class="automation-foot">
            <div class="automation-foot-head">
                <select class="select select--add" aria-label="Add an automation lane" @change="add">
                    <option value="">+ Automate a value…</option>
                    <optgroup v-for="group in groups" :key="group.label" :label="group.label">
                        <option v-for="param in group.params" :key="param.key" :value="param.key">{{ paramTitle(param) }}</option>
                    </optgroup>
                </select>
            </div>
            <div class="lane-foot">
                <span class="lane-hint">{{
                    props.track.automation.lanes.length ? 'Click the lane to add a point, drag it to move, double-click to remove. The curve loops with the pattern.' : 'Pick a value to draw over the loop: level, pan, an effect knob, the envelope.'
                }}</span>
                <button v-if="!props.track.automation.lanes.length" type="button" class="iconbtn iconbtn--tiny" aria-label="Close" @click="emit('close')">
                    <Icon icon="mdi:close" class="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    </div>
</template>
