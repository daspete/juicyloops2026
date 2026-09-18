<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { formatValue, movePoint, paramTitle, removePoint, setPoint, valueAt, type AutomationParam, type AutomationTarget, type SongAutomationLane } from '@/juicyloops/automation';
import { snapStep } from '@/juicyloops/song';
import { TRACK_META } from '../tracks/trackMeta';

/**
 * One automation lane of the arranger: a value of the master, a container or a track, drawn over the song.
 * Click the lane to add a point, drag a point to move it, double-click it to remove it.
 * Straight lines join the points; before the first and after the last the value holds.
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

/* ---- what the lane drives ---- */

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

const groups = computed(() => {
    const byGroup = new Map<string, AutomationParam[]>();
    for (const candidate of target.value?.parameters ?? []) {
        byGroup.set(candidate.group, [...(byGroup.get(candidate.group) ?? []), candidate]);
    }
    return [...byGroup.entries()].map(([label, params]) => ({ label, params }));
});

const onTarget = (event: Event) => {
    const option = targetOptions.value.find((candidate) => candidate.key === (event.target as HTMLSelectElement).value);
    if (!option) {
        return;
    }
    const params = resolveTarget(option.target)?.parameters ?? [];
    const keeps = params.some((candidate) => candidate.key === props.lane.param);
    song.value.retargetAutomation(props.lane.id, option.target, keeps ? props.lane.param : (params[0]?.key ?? props.lane.param));
};

const onParam = (event: Event) => {
    song.value.retargetAutomation(props.lane.id, props.lane.target, (event.target as HTMLSelectElement).value);
};

/* ---- the curve ---- */

const y = (value: number) => ((1 - value) * 100).toFixed(2);

const line = computed(() => {
    const points = props.lane.points;
    if (!points.length) {
        return '';
    }
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const inner = points.map((point) => `${point.step},${y(point.value)}`).join(' ');
    return `0,${y(first.value)} ${inner} ${props.totalSteps},${y(last.value)}`;
});

const area = computed(() => (line.value ? `0,100 ${line.value} ${props.totalSteps},100` : ''));

const pointStyle = (point: { step: number; value: number }) => ({
    left: `calc(${point.step} * var(--jl-song-step))`,
    top: `${(1 - point.value) * 100}%`,
});

const readout = (value: number) => (param.value ? formatValue(param.value, value) : `${Math.round(value * 100)}%`);

/** What the lane is doing right now, while the song plays. */
const live = computed(() => {
    const value = isPlaying.value ? valueAt(props.lane.points, currentStep.value) : null;
    return value === null ? null : readout(value);
});

/* ---- pointer interactions ---- */

const body = ref<HTMLElement | null>(null);
const dragIndex = ref<number | null>(null);

const locate = (event: PointerEvent): { step: number; value: number } | null => {
    const rect = body.value?.getBoundingClientRect();
    if (!rect) {
        return null;
    }
    const step = Math.min(props.totalSteps, snapStep(((event.clientX - rect.left) / rect.width) * props.totalSteps));
    const value = 1 - (event.clientY - rect.top) / rect.height;
    return { step, value: Math.round(Math.min(1, Math.max(0, value)) * 100) / 100 };
};

const onMove = (event: PointerEvent) => {
    const at = locate(event);
    if (dragIndex.value !== null && at) {
        dragIndex.value = movePoint(props.lane, dragIndex.value, at.step, at.value);
    }
};

const stopDrag = () => {
    dragIndex.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stopDrag);
};

const startDrag = (index: number) => {
    dragIndex.value = index;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stopDrag);
};

/** Pressing on the lane puts a point there and picks it up right away. */
const onLaneDown = (event: PointerEvent) => {
    const at = locate(event);
    if (event.button !== 0 || !at || !param.value) {
        return;
    }
    startDrag(setPoint(props.lane, at.step, at.value));
};

const onPointDown = (event: PointerEvent, index: number) => {
    if (event.button === 0) {
        startDrag(index);
    }
};

onBeforeUnmount(stopDrag);
</script>

<template>
    <div class="arr-row arr-row--auto" :style="{ '--jl-auto': `oklch(0.78 0.17 ${props.hue})` }">
        <div class="arr-head arr-head--auto">
            <div class="arr-head-title">
                <span class="autolane-swatch"></span>
                <select class="select select--tight" :value="targetKey(props.lane.target)" aria-label="What the lane drives" @change="onTarget">
                    <option v-if="!target" value="">Removed</option>
                    <option v-for="option in targetOptions" :key="option.key" :value="option.key">{{ option.label }}</option>
                </select>
            </div>
            <div class="arr-head-title">
                <select class="select select--tight" :value="props.lane.param" :disabled="!target" aria-label="Automated value" @change="onParam">
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

        <div ref="body" class="arr-lane arr-lane--auto" :data-dragging="dragIndex !== null" @pointerdown.self="onLaneDown">
            <svg class="auto-curve" :viewBox="`0 0 ${props.totalSteps} 100`" preserveAspectRatio="none" aria-hidden="true">
                <polygon v-if="area" :points="area" class="auto-area" />
                <polyline v-if="line" :points="line" class="auto-line" vector-effect="non-scaling-stroke" />
            </svg>
            <span
                v-for="(point, index) in props.lane.points"
                :key="`${point.step}-${index}`"
                class="auto-point"
                :data-active="dragIndex === index"
                :style="pointStyle(point)"
                :title="`${readout(point.value)} at step ${point.step + 1}. Drag to move, double-click to remove.`"
                @pointerdown.stop="onPointDown($event, index)"
                @dblclick.stop="removePoint(props.lane, index)"
            >
                <span v-if="dragIndex === index" class="auto-tag">{{ readout(point.value) }}</span>
            </span>
            <span v-if="!props.lane.points.length" class="auto-hint">{{ target ? 'Click to place the first point' : 'What this lane drove is gone' }}</span>
        </div>
    </div>
</template>
