<script setup lang="ts">
import JuicyKnob from '@/components/ui/JuicyKnob.vue';
import { injectLearnOwner } from '@/composables/useMidiLearn';
import { BEND_PARAM, BEND_RANGES, type SynthTrack } from '@/juicyloops/tracks/SynthTrack';

/**
 * Pitch bend: the knob bends every note (automation and a MIDI pitch wheel play on top of it), the range says how
 * many semitones a full bend reaches either way.
 */
const props = defineProps<{
    track: SynthTrack;
}>();

const owner = injectLearnOwner();
</script>

<template>
    <div class="setting">
        <div class="setting-label">Pitch bend</div>
        <div class="setting-row setting-row--tall flex-wrap">
            <JuicyKnob
                :model-value="props.track.bend"
                @update:model-value="props.track.setBend($event)"
                :min="BEND_PARAM.min"
                :max="BEND_PARAM.max"
                :step="BEND_PARAM.step"
                :format="BEND_PARAM.format"
                :reset-value="0"
                :label="BEND_PARAM.label"
                :hint="BEND_PARAM.hint"
                :learn="owner ? { target: owner, param: BEND_PARAM.key } : null"
                :size="60"
            />
            <div class="flex flex-col gap-1">
                <span class="text-xs text-(--jl-muted)">Range · semitones either way</span>
                <div class="flex flex-wrap gap-0.5" role="group" aria-label="Pitch bend range">
                    <button
                        v-for="range in BEND_RANGES"
                        :key="range"
                        type="button"
                        class="iconbtn font-mono"
                        :data-active="props.track.bendRange === range"
                        :aria-pressed="props.track.bendRange === range"
                        :aria-label="`Bend range ${range} semitones`"
                        @click="props.track.setBendRange(range)"
                    >
                        ±{{ range }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
