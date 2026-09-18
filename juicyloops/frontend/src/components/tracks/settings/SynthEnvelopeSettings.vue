<script setup lang="ts">
import { DEFAULT_ENVELOPE, type SynthEnvelopeParam, type SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import JuicyKnob from '@/components/ui/JuicyKnob.vue';
import { computed } from 'vue';

/** Attack / decay / sustain / release knobs with a live drawing of the resulting curve. */
const props = defineProps<{
    track: SynthTrack;
}>();

const seconds = (value: number) => (value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`);
const percent = (value: number) => `${Math.round(value * 100)}%`;

const STAGES: { key: SynthEnvelopeParam; label: string; min: number; max: number; step: number; curve: 'linear' | 'log'; format: (v: number) => string; hint: string }[] = [
    { key: 'attack', label: 'Attack', min: 0.001, max: 2, step: 0.001, curve: 'log', format: seconds, hint: 'How long the note takes to reach full volume' },
    { key: 'decay', label: 'Decay', min: 0.01, max: 2, step: 0.001, curve: 'log', format: seconds, hint: 'How long it takes to fall to the sustain level' },
    { key: 'sustain', label: 'Sustain', min: 0, max: 1, step: 0.01, curve: 'linear', format: percent, hint: 'The level held while the note plays' },
    { key: 'release', label: 'Release', min: 0.01, max: 4, step: 0.001, curve: 'log', format: seconds, hint: 'How long the tail rings out after the note ends' },
];

/* The curve: each stage gets horizontal room in proportion to its time (log-scaled so tiny attacks still show). */
const WIDTH = 220;
const HEIGHT = 56;
const PAD = 3;

const span = (seconds: number, max: number) => Math.log1p(seconds * 40) / Math.log1p(max * 40);

const curve = computed(() => {
    const { attack, decay, sustain, release } = props.track.envelope;
    const a = span(attack, 2);
    const d = span(decay, 2);
    const r = span(release, 4);
    const hold = 0.6;
    const total = a + d + hold + r;
    const x = (t: number) => PAD + (t / total) * (WIDTH - PAD * 2);
    const y = (level: number) => HEIGHT - PAD - level * (HEIGHT - PAD * 2);

    const points = [
        [x(0), y(0)],
        [x(a), y(1)],
        [x(a + d), y(sustain)],
        [x(a + d + hold), y(sustain)],
        [x(total), y(0)],
    ];
    const line = points.map(([px, py]) => `${px!.toFixed(1)},${py!.toFixed(1)}`).join(' ');
    return { line, area: `${line} ${x(total).toFixed(1)},${y(0)} ${x(0).toFixed(1)},${y(0)}` };
});
</script>

<template>
    <div class="setting">
        <div class="setting-label">Shape</div>
        <div class="setting-row setting-row--tall flex-wrap">
            <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" :width="WIDTH" :height="HEIGHT" class="shrink-0 setting-canvas" aria-hidden="true">
                <polygon :points="curve.area" fill="var(--jl-accent)" opacity="0.18" />
                <polyline :points="curve.line" fill="none" stroke="var(--jl-accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            </svg>
            <div class="flex gap-4">
                <JuicyKnob
                    v-for="stage in STAGES"
                    :key="stage.key"
                    :model-value="props.track.envelope[stage.key]"
                    @update:model-value="props.track.setEnvelope(stage.key, $event)"
                    :min="stage.min"
                    :max="stage.max"
                    :step="stage.step"
                    :curve="stage.curve"
                    :format="stage.format"
                    :reset-value="DEFAULT_ENVELOPE[stage.key]"
                    :label="stage.label"
                    :hint="stage.hint"
                    :size="60"
                />
            </div>
        </div>
    </div>
</template>
