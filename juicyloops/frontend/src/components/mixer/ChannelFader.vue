<script setup lang="ts">
import { meterPosition, type MeterReading } from '@/composables/useMeter';
import { computed, ref } from 'vue';

/**
 * A vertical fader with the channel's meter beside it, the way a mixing desk has them.
 *  - drag the cap (or anywhere on the track: it jumps there first), Shift for fine moves,
 *  - scroll the wheel over it, arrow keys when focused (Shift: bigger steps), Home/End for the ends,
 *  - double-click resets to 0 dB.
 * The scale is not linear: most of the travel covers -20..+6 dB, where mixing happens.
 */
const props = withDefaults(
    defineProps<{
        modelValue: number;
        min?: number;
        max?: number;
        label: string;
        reading?: MeterReading | null;
        /** Short strips hide the scale. */
        compact?: boolean;
    }>(),
    { min: -40, max: 6, reading: null, compact: false },
);

const emit = defineEmits<{
    'update:modelValue': [value: number];
}>();

const EXPONENT = 2.2;

const toPosition = (db: number): number => Math.pow((Math.min(props.max, Math.max(props.min, db)) - props.min) / (props.max - props.min), 1 / EXPONENT);
const fromPosition = (position: number): number => {
    const t = Math.pow(Math.min(1, Math.max(0, position)), EXPONENT);
    return Math.round((props.min + t * (props.max - props.min)) * 10) / 10;
};

const position = computed(() => toPosition(props.modelValue));

const TICKS = [6, 0, -6, -12, -20, -40];

const set = (value: number) => {
    const next = Math.round(Math.min(props.max, Math.max(props.min, value)) * 10) / 10;
    if (next !== props.modelValue) {
        emit('update:modelValue', next);
    }
};

const track = ref<HTMLElement | null>(null);
const isDragging = ref(false);
let drag: { pointerId: number; startY: number; startPosition: number } | null = null;

const positionAt = (clientY: number): number => {
    const rect = track.value!.getBoundingClientRect();
    return 1 - (clientY - rect.top) / rect.height;
};

const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
        return;
    }
    event.preventDefault();
    (event.currentTarget as HTMLElement).focus();
    const onCap = (event.target as HTMLElement).closest('.fader-cap');
    if (!onCap) {
        set(fromPosition(positionAt(event.clientY)));
    }
    drag = { pointerId: event.pointerId, startY: event.clientY, startPosition: onCap ? position.value : positionAt(event.clientY) };
    isDragging.value = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};

const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
        return;
    }
    const height = track.value!.getBoundingClientRect().height;
    const delta = ((drag.startY - event.clientY) / height) * (event.shiftKey ? 0.2 : 1);
    set(fromPosition(drag.startPosition + delta));
};

const onPointerUp = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointerId) {
        drag = null;
        isDragging.value = false;
    }
};

const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    set(props.modelValue + (event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 0.1 : 0.5));
};

const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 3 : 0.5;
    const actions: Record<string, () => void> = {
        ArrowUp: () => set(props.modelValue + step),
        ArrowRight: () => set(props.modelValue + step),
        ArrowDown: () => set(props.modelValue - step),
        ArrowLeft: () => set(props.modelValue - step),
        Home: () => set(props.max),
        End: () => set(props.min),
    };
    const action = actions[event.key];
    if (action) {
        event.preventDefault();
        action();
    }
};

const readout = computed(() => (props.modelValue <= props.min ? '-∞' : `${props.modelValue > 0 ? '+' : ''}${props.modelValue.toFixed(1)}`));

/** The fill spans the whole bar (so its colours sit at fixed levels); clipping its top shows the level. */
const meterClip = (channel: 0 | 1) => `inset(${(1 - meterPosition(props.reading?.levels[channel] ?? -Infinity)) * 100}% 0 0 0)`;
const peakBottom = (channel: 0 | 1) => `${meterPosition(props.reading?.peaks[channel] ?? -Infinity) * 100}%`;

defineExpose({ readout });
</script>

<template>
    <div class="fader" :class="{ 'fader--compact': props.compact, 'fader--dragging': isDragging }">
        <div class="fader-clip" :data-on="props.reading?.clipped ?? false" aria-hidden="true" title="Clipped: this channel went over 0 dB"></div>
        <div class="fader-body">
            <div v-if="!props.compact" class="fader-scale" aria-hidden="true">
                <span v-for="tick in TICKS" :key="tick" :style="{ bottom: `${toPosition(tick) * 100}%` }">{{ tick > 0 ? `+${tick}` : tick }}</span>
            </div>
            <div
                ref="track"
                class="fader-track"
                role="slider"
                tabindex="0"
                :aria-label="props.label"
                :aria-valuemin="props.min"
                :aria-valuemax="props.max"
                :aria-valuenow="props.modelValue"
                :aria-valuetext="`${readout} dB`"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerUp"
                @wheel="onWheel"
                @keydown="onKeyDown"
                @dblclick="set(0)"
            >
                <div class="fader-groove"></div>
                <div class="fader-zero" :style="{ bottom: `${toPosition(0) * 100}%` }"></div>
                <div class="fader-cap" :style="{ bottom: `${position * 100}%` }"></div>
            </div>
            <div class="fader-meter" aria-hidden="true">
                <div v-for="channel in [0, 1] as const" :key="channel" class="fader-meter-bar">
                    <div class="fader-meter-fill" :style="{ clipPath: meterClip(channel) }"></div>
                    <div class="fader-meter-peak" :style="{ bottom: peakBottom(channel) }"></div>
                </div>
            </div>
        </div>
    </div>
</template>
