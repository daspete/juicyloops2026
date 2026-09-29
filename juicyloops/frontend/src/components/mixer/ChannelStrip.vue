<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import type { ChannelModel } from '@/composables/useChannels';
import { useMeter } from '@/composables/useMeter';
import { useWorkspace } from '@/composables/useWorkspace';
import { EFFECT_INFO } from '@/juicyloops/effects/definitions';
import { RETURN_NAMES, SEND_MAX, SEND_OFF, sendParamKey } from '@/juicyloops/sends';
import { useMidi } from '@/composables/useMidi';
import JuicyKnob from '../ui/JuicyKnob.vue';
import ChannelFader from './ChannelFader.vue';

/**
 * One strip of the mixer rack. Every channel has the same anatomy, top to bottom: colour cap and name, the inserts
 * (its effect chain), the sends to the returns, pan, the fader with its meter, the level readout, mute / solo (and arm
 * on a track), and the role plate. A click anywhere on the strip selects its channel.
 *
 * `simple` (Quick mode) leaves out inserts and sends; `narrow` keeps only the fader, the meter and the switches.
 */
const props = defineProps<{
    channel: ChannelModel;
    narrow?: boolean;
    simple?: boolean;
}>();

const { selectChannel, isChannelSelected, openDock } = useWorkspace();
const { isAnyArmed } = useMidi();

const isSelected = computed(() => isChannelSelected(props.channel.target));
const meterSource = computed(() => props.channel.meterSource);
const reading = useMeter(meterSource);

const inserts = computed(() => {
    // Read for reactivity: the chain lives on a raw object.
    void props.channel.effects.revision;
    const effects = props.channel.effects;
    return effects.chain.map((slot) => ({
        id: slot.id,
        label: effects.slotLabel(slot.id),
        icon: EFFECT_INFO[slot.effect].icon,
        on: effects.isNeeded(slot.id),
        bypassed: slot.bypassed,
    }));
});

const volume = computed({
    get: () => props.channel.volume,
    set: (value: number) => props.channel.setVolume(value),
});

const pan = computed({
    get: () => props.channel.pan,
    set: (value: number) => props.channel.setPan(value),
});

const readout = computed(() => (volume.value <= -40 ? '-∞' : `${volume.value > 0 ? '+' : ''}${volume.value.toFixed(1)}`));

const formatPan = (value: number) => (Math.abs(value) < 0.005 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`);
const formatSend = (value: number) => (value <= SEND_OFF ? 'Off' : `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`);

const track = computed(() => props.channel.track ?? null);
const armState = computed(() => (track.value?.isArmed ? 'armed' : !isAnyArmed.value && isSelected.value && track.value ? 'implicit' : 'off'));

const select = () => selectChannel(props.channel.target);

/** An insert opens the device rack on this channel. */
const openInserts = () => {
    select();
    openDock('devices');
};

const learn = (param: string) => ({ target: props.channel.target, param });
</script>

<template>
    <section
        class="mstrip"
        :class="{ 'mstrip--narrow': props.narrow, 'mstrip--selected': isSelected, [`mstrip--${props.channel.kind}`]: true }"
        :style="{ '--jl-accent': props.channel.accent }"
        :aria-label="`${props.channel.name} channel`"
        @pointerdown="select"
    >
        <header class="mstrip-cap">
            <Icon :icon="props.channel.icon" class="mstrip-icon" />
            <span class="mstrip-name" :title="props.channel.name">{{ props.channel.name }}</span>
        </header>

        <div v-if="!props.narrow && !props.simple" class="mstrip-inserts" aria-label="Effects">
            <button
                v-for="insert in inserts.slice(0, 3)"
                :key="insert.id"
                type="button"
                class="mstrip-insert"
                :data-on="insert.on"
                :data-bypassed="insert.bypassed"
                :title="`${insert.label}${insert.bypassed ? ' (bypassed)' : ''}: click to open`"
                @click="openInserts"
            >
                <span class="mstrip-insert-dot"></span>
                <span class="mstrip-insert-label">{{ insert.label }}</span>
            </button>
            <button v-if="inserts.length > 3" type="button" class="mstrip-insert mstrip-insert--more" @click="openInserts">+{{ inserts.length - 3 }} more</button>
            <button type="button" class="mstrip-insert mstrip-insert--add" :title="'Add an effect'" @click="openInserts">
                <Icon icon="mdi:plus" class="w-3 h-3" />
                <span>{{ inserts.length ? 'Effect' : 'Add effect' }}</span>
            </button>
        </div>

        <div v-if="!props.narrow" class="mstrip-knobs">
            <template v-if="!props.simple && props.channel.sends">
                <JuicyKnob
                    v-for="(level, index) in props.channel.sends"
                    :key="index"
                    :model-value="level"
                    :min="SEND_OFF"
                    :max="SEND_MAX"
                    :step="0.1"
                    :label="RETURN_NAMES[index]!"
                    :hint="`Send to return ${RETURN_NAMES[index]}`"
                    :reset-value="SEND_OFF"
                    :format="formatSend"
                    :learn="learn(sendParamKey(index))"
                    :size="24"
                    class="mstrip-knob mstrip-knob--send"
                    @update:model-value="props.channel.setSend(index, $event)"
                />
            </template>
            <JuicyKnob v-model="pan" :min="-1" :max="1" :step="0.01" label="Pan" :reset-value="0" :format="formatPan" :learn="learn('pan')" :size="24" class="mstrip-knob" />
        </div>

        <ChannelFader v-model="volume" :label="`${props.channel.name} level`" :reading="reading" :compact="props.narrow" class="mstrip-fader" />

        <div class="mstrip-readout" :data-clip="reading.clipped">{{ readout }}<small v-if="!props.narrow"> dB</small></div>

        <div class="mstrip-switches">
            <button
                type="button"
                class="mstrip-switch mstrip-switch--mute"
                :data-active="props.channel.isMuted"
                :aria-pressed="props.channel.isMuted"
                v-tooltip.top="'Mute'"
                @click.stop="props.channel.toggleMute()"
            >
                M
            </button>
            <button
                v-if="props.channel.canSolo"
                type="button"
                class="mstrip-switch mstrip-switch--solo"
                :data-active="props.channel.isSolo"
                :aria-pressed="props.channel.isSolo"
                v-tooltip.top="'Solo: hear only soloed channels'"
                @click.stop="props.channel.toggleSolo()"
            >
                S
            </button>
            <button
                v-if="track && !props.narrow"
                type="button"
                class="mstrip-switch mstrip-switch--arm"
                :data-state="armState"
                :aria-pressed="track.isArmed"
                v-tooltip.top="'Arm for MIDI input and recording'"
                @click.stop="track.setArmed(!track.isArmed)"
            >
                <Icon icon="mdi:record" class="w-3 h-3" />
            </button>
        </div>

        <footer class="mstrip-plate">{{ props.narrow ? props.channel.role.slice(0, 3) : props.channel.role }}</footer>
    </section>
</template>
