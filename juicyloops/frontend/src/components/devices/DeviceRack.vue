<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, ref, shallowRef } from 'vue';
import { channelOf, type ChannelModel } from '@/composables/useChannels';
import { useHistory } from '@/composables/useHistory';
import { provideLearnOwner } from '@/composables/useMidiLearn';
import { useMeter } from '@/composables/useMeter';
import { useWorkspace } from '@/composables/useWorkspace';
import { EFFECT_CATEGORIES, EFFECT_DEFINITIONS, EFFECT_INFO, EFFECT_KEYS, type EffectKey } from '@/juicyloops/effects/definitions';
import type { Effects } from '@/juicyloops/effects/effects';
import { RETURN_NAMES, SEND_MAX, SEND_OFF, sendParamKey } from '@/juicyloops/sends';
import EffectDevice from '../effects/EffectDevice.vue';
import ChannelFader from '../mixer/ChannelFader.vue';
import JuicyKnob from '../ui/JuicyKnob.vue';
import InstrumentDevice from './InstrumentDevice.vue';
import { deviceClipboard, pasteDevice } from './deviceClipboard';

/**
 * The device rack: the whole signal path of the selected channel on one row, left to right. A track starts with its
 * instrument; every channel then has its effect slots, a card to add one, and ends in the channel itself (level, pan,
 * sends, mute and solo). Cards can be dragged to reorder and Alt-dragged to copy; Copy in a card's menu and Paste on
 * the add card carry a device to another channel.
 */
const { selectedChannel, dock, setDeviceFace, isPro } = useWorkspace();
const { version } = useHistory();

const channel = computed<ChannelModel | null>(() => (selectedChannel.value ? channelOf(selectedChannel.value) : null));
provideLearnOwner(computed(() => channel.value?.target ?? null));

const effects = computed<Effects | null>(() => channel.value?.effects ?? null);

const slots = computed(() => {
    const rack = effects.value;
    if (!rack) {
        return [];
    }
    void rack.revision;
    return rack.chain.map((slot) => slot.id);
});

const face = computed(() => (isPro.value ? dock.value.face : 'macro'));

/* ---- adding an effect ---- */

const isAdding = ref(false);

const addEffect = (effect: EffectKey) => {
    effects.value?.add(effect);
    isAdding.value = false;
};

const categories = EFFECT_CATEGORIES.map((category) => ({
    ...category,
    effects: EFFECT_KEYS.filter((key) => EFFECT_INFO[key].category === category.key).map((key) => ({ key, label: EFFECT_DEFINITIONS[key].label, ...EFFECT_INFO[key] })),
}));

/* ---- drag to reorder / copy ---- */

interface DragSource {
    rack: Effects;
    slotId: string;
}

const dragging = shallowRef<DragSource | null>(null);
const dropIndex = ref<number | null>(null);

const onDragStart = (event: DragEvent, slotId: string) => {
    if (!effects.value) {
        return;
    }
    dragging.value = { rack: effects.value, slotId };
    event.dataTransfer?.setData('text/plain', slotId);
    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'copyMove';
    }
};

const onDragOver = (event: DragEvent, index: number) => {
    if (!dragging.value) {
        return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropIndex.value = event.clientX > rect.left + rect.width / 2 ? index + 1 : index;
};

const onDrop = (event: DragEvent) => {
    const source = dragging.value;
    const rack = effects.value;
    const index = dropIndex.value;
    dragging.value = null;
    dropIndex.value = null;
    if (!source || !rack || index === null) {
        return;
    }
    event.preventDefault();
    if (event.altKey) {
        const effect = source.rack.effectOf(source.slotId);
        if (effect) {
            const id = rack.add(effect, index, source.rack.paramsOf(source.slotId));
            rack.setBypassed(id, source.rack.isBypassed(source.slotId));
        }
        return;
    }
    const from = rack.chain.findIndex((slot) => slot.id === source.slotId);
    rack.moveTo(source.slotId, from < index ? index - 1 : index);
};

const onDragEnd = () => {
    dragging.value = null;
    dropIndex.value = null;
};

/* ---- the channel end ---- */

const meterSource = computed(() => channel.value?.meterSource ?? null);
const reading = useMeter(meterSource);

const volume = computed({
    get: () => channel.value?.volume ?? 0,
    set: (value: number) => channel.value?.setVolume(value),
});

const pan = computed({
    get: () => channel.value?.pan ?? 0,
    set: (value: number) => channel.value?.setPan(value),
});

const formatPan = (value: number) => (Math.abs(value) < 0.005 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`);
const formatSend = (value: number) => (value <= SEND_OFF ? 'Off' : `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`);
const learn = (param: string) => (channel.value ? { target: channel.value.target, param } : null);
</script>

<template>
    <div class="rack2" :style="{ '--jl-accent': channel?.accent ?? 'var(--jl-brand)' }">
        <div v-if="!channel || !effects" class="rack2-empty">
            <Icon icon="mdi:cursor-default-click-outline" class="w-6 h-6" />
            <span>Select a track, or a strip in the mixer, to see its devices.</span>
        </div>
        <template v-else>
            <div class="rack2-bar">
                <span class="track-badge"><Icon :icon="channel.icon" class="w-4 h-4" /></span>
                <span class="rack2-name">{{ channel.name }}</span>
                <span class="rack2-role">{{ channel.role }}</span>
                <span class="rack2-flow" aria-hidden="true">{{ channel.track ? 'instrument → effects → channel' : 'input → effects → channel' }}</span>
                <div class="flex-1"></div>
                <div v-if="isPro" class="segmented" role="radiogroup" aria-label="Device face">
                    <button type="button" role="radio" :aria-checked="face === 'macro'" :data-active="face === 'macro'" v-tooltip.top="'The main knobs of every device, with plain names'" @click="setDeviceFace('macro')">
                        Simple
                    </button>
                    <button type="button" role="radio" :aria-checked="face === 'full'" :data-active="face === 'full'" v-tooltip.top="'Every parameter of every device'" @click="setDeviceFace('full')">Full</button>
                </div>
            </div>

            <div class="rack2-chain" @dragover.prevent @drop="onDrop">
                <InstrumentDevice v-if="channel.track" :key="`${channel.key}-${version}`" :track="channel.track" :face="face" />
                <Icon v-if="channel.track" icon="mdi:chevron-right" class="rack2-arrow" aria-hidden="true" />

                <template v-for="(slotId, index) in slots" :key="slotId">
                    <div class="rack2-drop" :data-active="dropIndex === index && dragging !== null" aria-hidden="true"></div>
                    <div class="rack2-slot" :data-dragging="dragging?.slotId === slotId" @dragover="onDragOver($event, index)">
                        <EffectDevice :effects="effects" :slot-id="slotId" :face="face" :version="version" @dragstart="onDragStart($event, slotId)" @dragend="onDragEnd" />
                    </div>
                    <Icon icon="mdi:chevron-right" class="rack2-arrow" aria-hidden="true" />
                </template>
                <div class="rack2-drop" :data-active="dropIndex === slots.length && dragging !== null" aria-hidden="true"></div>

                <div class="rack2-add" @dragover="onDragOver($event, slots.length)">
                    <template v-if="!isAdding">
                    <button type="button" class="rack2-add-button" @click="isAdding = true">
                        <Icon icon="mdi:plus" class="w-6 h-6" />
                        <span>Add effect</span>
                        <small v-if="!slots.length">Reverb, delay, EQ, …</small>
                    </button>
                    <button v-if="deviceClipboard" type="button" class="rack2-paste" v-tooltip.top="'Paste the copied device here'" @click="pasteDevice(effects)">
                        <Icon icon="mdi:content-paste" class="w-4 h-4" />
                        <span>Paste {{ deviceClipboard.label }}</span>
                    </button>
                    </template>
                    <div v-else class="rack2-picker" role="menu" aria-label="Add an effect" @keydown.escape="isAdding = false">
                        <header class="rack2-picker-head">
                            <span>Add an effect</span>
                            <button type="button" class="iconbtn" aria-label="Close" @click="isAdding = false"><Icon icon="mdi:close" class="w-4 h-4" /></button>
                        </header>
                        <div class="rack2-picker-body">
                            <section v-for="category in categories" :key="category.key" class="rack2-picker-group">
                                <h4><Icon :icon="category.icon" class="w-3.5 h-3.5" /> {{ category.label }}</h4>
                                <button v-for="item in category.effects" :key="item.key" type="button" class="rack2-picker-item" role="menuitem" @click="addEffect(item.key)">
                                    <Icon :icon="item.icon" class="w-4 h-4" />
                                    <span class="rack2-picker-label">{{ item.label }}</span>
                                    <small>{{ item.blurb }}</small>
                                </button>
                            </section>
                        </div>
                    </div>
                </div>

                <aside class="rack2-channel" :aria-label="`${channel.name} channel`">
                    <header class="device-card-head">
                        <span class="device-power device-power--fixed" aria-hidden="true"><Icon icon="mdi:tune-vertical" class="w-4 h-4" /></span>
                        <span class="device-card-name">Channel</span>
                    </header>
                    <div class="rack2-channel-body">
                        <ChannelFader v-model="volume" :label="`${channel.name} level`" :reading="reading" class="rack2-fader" />
                        <div class="rack2-channel-knobs">
                            <JuicyKnob v-model="pan" :min="-1" :max="1" :step="0.01" label="Pan" :reset-value="0" :format="formatPan" :learn="learn('pan')" :size="40" />
                            <template v-if="isPro && channel.sends">
                                <JuicyKnob
                                    v-for="(level, index) in channel.sends"
                                    :key="index"
                                    :model-value="level"
                                    :min="SEND_OFF"
                                    :max="SEND_MAX"
                                    :step="0.1"
                                    :label="`Send ${RETURN_NAMES[index]}`"
                                    :reset-value="SEND_OFF"
                                    :format="formatSend"
                                    :learn="learn(sendParamKey(index))"
                                    :size="40"
                                    @update:model-value="channel.setSend(index, $event)"
                                />
                            </template>
                            <div class="mstrip-switches">
                                <button type="button" class="mstrip-switch mstrip-switch--mute" :data-active="channel.isMuted" :aria-pressed="channel.isMuted" @click="channel.toggleMute()">M</button>
                                <button v-if="channel.canSolo" type="button" class="mstrip-switch mstrip-switch--solo" :data-active="channel.isSolo" :aria-pressed="channel.isSolo" @click="channel.toggleSolo()">S</button>
                            </div>
                        </div>
                    </div>
                </aside>
            </div>
        </template>
    </div>
</template>
