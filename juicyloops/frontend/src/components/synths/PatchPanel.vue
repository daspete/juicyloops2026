<script setup lang="ts">
import { patchParam, type PatchModel, type PatchParam } from '@/juicyloops/synths/params';
import type { SynthTrack } from '@/juicyloops/tracks/SynthTrack';
import { computed } from 'vue';
import EnvelopeCurve from './EnvelopeCurve.vue';
import PatchControl from './PatchControl.vue';

/**
 * The controls of an analog, wavetable or FM synth. The macro face is one block of the main controls; the full face
 * shows every section (oscillators, filter, envelopes, LFOs, matrix, voice), flowing into as many columns as the
 * card is wide.
 */
const props = defineProps<{
    track: SynthTrack;
    model: PatchModel;
    face: 'macro' | 'full';
}>();

interface Section {
    title: string;
    /** Keys (without `patch.`) of the pickers, then the knobs. */
    choices?: string[];
    knobs?: string[];
    /** An envelope drawn above its knobs: the key prefix (`amp`, `filterEnv`, `op2`). */
    envelope?: string;
    /** The modulation matrix. */
    matrix?: boolean;
    wide?: boolean;
}

const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
const envelopeKeys = (prefix: string) => ['attack', 'decay', 'sustain', 'release'].map((stage) => `${prefix}.${stage}`);

const lfoSection = (n: number): Section => ({
    title: `LFO ${n}`,
    choices: [`lfo${n}.shape`, `lfo${n}.sync`, `lfo${n}.retrigger`, `lfo${n}.dest`],
    knobs: [`lfo${n}.rate`, `lfo${n}.amount`, `lfo${n}.fade`],
});

const shared = (model: PatchModel): Section[] => [
    { title: 'Filter', choices: ['filter.type'], knobs: ['filter.cutoff', 'filter.resonance', 'filter.drive', 'filter.env', 'filter.keyTrack', 'filter.velocity'] },
    { title: 'Filter envelope', envelope: 'filterEnv', knobs: envelopeKeys('filterEnv') },
    { title: 'Amp envelope', envelope: 'amp', knobs: envelopeKeys('amp') },
    lfoSection(1),
    lfoSection(2),
    { title: 'Matrix', matrix: true, wide: true },
    {
        title: 'Voice',
        knobs: ['volume', 'pan', 'glide', 'velocity', 'modWheel', ...(model === 'fm' ? [] : ['unison', 'detune', 'spread'])],
    },
];

const FULL: Record<PatchModel, Section[]> = {
    analog: [
        ...range(3).map((n) => ({ title: `Osc ${n}`, choices: [`osc${n}.wave`], knobs: [`osc${n}.octave`, `osc${n}.semi`, `osc${n}.fine`, `osc${n}.level`, `osc${n}.width`] })),
        { title: 'Mixer', knobs: ['sub', 'noise'] },
        ...shared('analog'),
    ],
    wavetable: [
        ...range(2).map((n) => ({ title: `Osc ${n}`, choices: [`osc${n}.table`], knobs: [`osc${n}.position`, `osc${n}.octave`, `osc${n}.semi`, `osc${n}.fine`, `osc${n}.level`] })),
        { title: 'Mixer', knobs: ['sub', 'noise'] },
        ...shared('wavetable'),
    ],
    fm: [
        { title: 'Operators', choices: ['fm.algorithm'], knobs: ['fm.feedback'] },
        ...range(4).map((n) => ({ title: `Operator ${n}`, envelope: `op${n}`, knobs: [`op${n}.ratio`, `op${n}.detune`, `op${n}.level`, `op${n}.velocity`, ...envelopeKeys(`op${n}`)] })),
        ...shared('fm'),
    ],
};

const MACRO: Record<PatchModel, Section> = {
    analog: {
        title: 'Main',
        choices: ['osc1.wave', 'filter.type'],
        knobs: ['osc2.level', 'filter.cutoff', 'filter.resonance', 'filter.env', 'amp.attack', 'amp.decay', 'amp.sustain', 'amp.release', 'unison', 'detune'],
    },
    wavetable: {
        title: 'Main',
        choices: ['osc1.table', 'filter.type'],
        knobs: ['osc1.position', 'osc2.level', 'filter.cutoff', 'filter.resonance', 'filter.env', 'amp.attack', 'amp.decay', 'amp.sustain', 'amp.release', 'unison'],
    },
    fm: {
        title: 'Main',
        choices: ['fm.algorithm'],
        knobs: ['fm.feedback', 'op2.ratio', 'op2.level', 'op3.level', 'op4.level', 'amp.attack', 'amp.decay', 'amp.sustain', 'amp.release'],
    },
};

/** Names for the macro face, where a knob stands without its section. */
const MACRO_LABELS: Record<string, string> = {
    'osc1.wave': 'Wave',
    'osc1.table': 'Table',
    'osc1.position': 'Position',
    'osc2.level': 'Osc 2',
    'filter.type': 'Filter',
    'op2.ratio': 'Op 2 ratio',
    'op2.level': 'Op 2',
    'op3.level': 'Op 3',
    'op4.level': 'Op 4',
    'fm.algorithm': 'Algorithm',
};

const param = (key: string): PatchParam | undefined => patchParam(props.model, `patch.${key}`);
const params = (keys: readonly string[] | undefined): PatchParam[] => (keys ?? []).map(param).filter((p): p is PatchParam => !!p);

const sections = computed(() => (props.face === 'macro' ? [MACRO[props.model]] : FULL[props.model]));

const envelopeOf = (prefix: string) => {
    const read = (stage: string) => props.track.patch[`patch.${prefix}.${stage}`] ?? 0;
    return { attack: read('attack'), decay: read('decay'), sustain: read('sustain'), release: read('release') };
};

/** A synced LFO has no rate in Hz; its knob steps aside. */
const isHidden = (key: string) => {
    const lfo = /^lfo(\d)\.rate$/.exec(key);
    return !!lfo && (props.track.patch[`patch.lfo${lfo[1]}.sync`] ?? 0) > 0;
};

const label = (key: string): string | undefined => (props.face === 'macro' ? MACRO_LABELS[key] : undefined);
</script>

<template>
    <div class="patch-panel" :data-face="props.face">
        <section v-for="section in sections" :key="section.title" class="patch-section" :class="{ 'patch-section--wide': section.wide }" :aria-label="section.title">
            <div v-if="props.face === 'full'" class="setting-label">{{ section.title }}</div>
            <div v-if="section.choices?.length" class="patch-choices">
                <PatchControl v-for="choice in params(section.choices)" :key="choice.key" :track="props.track" :param="choice" :label="label(choice.key.slice(6))" />
            </div>
            <EnvelopeCurve v-if="section.envelope" v-bind="envelopeOf(section.envelope)" />
            <div v-if="section.matrix" class="patch-matrix">
                <div v-for="slot in 4" :key="slot" class="patch-matrix-row">
                    <PatchControl :track="props.track" :param="param(`mod${slot}.source`)!" label="From" />
                    <PatchControl :track="props.track" :param="param(`mod${slot}.dest`)!" label="To" />
                    <PatchControl :track="props.track" :param="param(`mod${slot}.amount`)!" label="Amount" :size="38" />
                </div>
            </div>
            <div v-if="section.knobs?.length" class="patch-knobs">
                <template v-for="knob in params(section.knobs)" :key="knob.key">
                    <PatchControl v-if="!isHidden(knob.key.slice(6))" :track="props.track" :param="knob" :label="label(knob.key.slice(6))" />
                </template>
            </div>
        </section>
    </div>
</template>
