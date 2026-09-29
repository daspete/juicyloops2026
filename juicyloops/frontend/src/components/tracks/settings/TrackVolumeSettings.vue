<script setup lang="ts">
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { ref } from 'vue';
import { TRACK_META } from '../trackMeta';
import VelocityLane from '../velocity/VelocityLane.vue';
import VelocityTools from '../velocity/VelocityTools.vue';
import { useVelocityHeight } from '../velocity/useVelocityTool';

/**
 * Velocity lane under the step grid: one stem per note, centred under its pad (an off-grid note sits between pads,
 * a chord's stems stand side by side). Empty steps show a ghost stem, the velocity a new step gets.
 */
const props = defineProps<{
    track: BaseTrack;
}>();

const height = useVelocityHeight('steps', 96);
const lane = ref<InstanceType<typeof VelocityLane> | null>(null);
</script>

<template>
    <div class="lane-stack">
        <VelocityLane ref="lane" v-model:height="height" :pattern="props.track" :min-height="48" :max-height="260" :title="`${TRACK_META[props.track.type].label} velocity`" />
        <div class="velo-foot">
            <VelocityTools @menu="lane?.openMenu($event)" />
            <span class="lane-hint">Drag a stem's head to change it (Shift: fine) · sweep to draw · right-click for humanize, ramps and accents</span>
        </div>
    </div>
</template>
