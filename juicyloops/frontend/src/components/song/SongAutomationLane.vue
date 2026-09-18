<script setup lang="ts">
import { computed } from 'vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import type { AutomationParam, AutomationTarget, SongAutomationLane } from '@/juicyloops/automation';
import { SONG_SNAP } from '@/juicyloops/song';
import AutomationCurve from '../ui/AutomationCurve.vue';
import AutomationLaneHead from '../ui/AutomationLaneHead.vue';
import { TRACK_META } from '../tracks/trackMeta';

/**
 * One automation lane of the arranger: a value of the master, a container or a track, drawn over the song.
 * The head picks what the lane drives, the body is the curve.
 */
const props = defineProps<{
    lane: SongAutomationLane;
    totalSteps: number;
    /** Hue of the curve, so lanes are told apart at a glance. */
    hue: number;
}>();

const emit = defineEmits<{
    remove: [];
}>();

const { containers, song, resolveTarget, currentStep, isPlaying } = useJuicyLoops();

interface TargetOption {
    key: string;
    label: string;
    target: AutomationTarget;
}

const targetKey = (target: AutomationTarget): string =>
    target.kind === 'master' ? 'master' : target.kind === 'container' ? `container:${target.containerId}` : `track:${target.containerId}:${target.trackId}`;

/** Everything a lane can drive: the master, every container, every track of every container. */
const targetOptions = computed<TargetOption[]>(() => [
    { key: 'master', label: 'Master', target: { kind: 'master' } },
    ...containers.value.flatMap((container) => [
        { key: `container:${container.id}`, label: container.name, target: { kind: 'container', containerId: container.id } as AutomationTarget },
        ...container.tracks.map((track, index) => ({
            key: `track:${container.id}:${track.id}`,
            label: `${container.name} › ${TRACK_META[track.type].label} ${index + 1}`,
            target: { kind: 'track', containerId: container.id, trackId: track.id } as AutomationTarget,
        })),
    ]),
]);

const target = computed(() => resolveTarget(props.lane.target));
const param = computed<AutomationParam | undefined>(() => target.value?.parameters.find((candidate) => candidate.key === props.lane.param));

const onTarget = (event: Event) => {
    const option = targetOptions.value.find((candidate) => candidate.key === (event.target as HTMLSelectElement).value);
    if (!option) {
        return;
    }
    const params = resolveTarget(option.target)?.parameters ?? [];
    const keeps = params.some((candidate) => candidate.key === props.lane.param);
    song.value.retargetAutomation(props.lane.id, option.target, keeps ? props.lane.param : (params[0]?.key ?? props.lane.param));
};

const onParam = (key: string) => {
    song.value.retargetAutomation(props.lane.id, props.lane.target, key);
};
</script>

<template>
    <div class="arr-row arr-row--auto" :style="{ '--jl-auto': `oklch(0.78 0.17 ${props.hue})` }">
        <AutomationLaneHead
            class="arr-head arr-head--auto"
            :curve="props.lane"
            :param="param"
            :parameters="target?.parameters ?? []"
            :current-step="isPlaying ? currentStep : null"
            @param="onParam"
            @remove="emit('remove')"
        >
            <select class="select select--tight" :value="targetKey(props.lane.target)" aria-label="What the lane drives" @change="onTarget">
                <option v-if="!target" value="">Removed</option>
                <option v-for="option in targetOptions" :key="option.key" :value="option.key">{{ option.label }}</option>
            </select>
        </AutomationLaneHead>

        <AutomationCurve
            class="arr-lane arr-lane--auto"
            :curve="props.lane"
            :total-steps="props.totalSteps"
            :snap="SONG_SNAP"
            :param="param"
            :disabled="!target"
            :hint="props.lane.points.length ? '' : target ? 'Click to place the first point' : 'What this lane drove is gone'"
        />
    </div>
</template>
