<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, ref } from 'vue';
import { usePresets } from '@/composables/usePresets';
import { EFFECT_DEFINITIONS, EFFECT_INFO, EFFECT_PRESETS, addedParams, type EffectParamDefinition } from '@/juicyloops/effects/definitions';
import type { Effects } from '@/juicyloops/effects/effects';
import SongMenu, { type SongMenuItem } from '../song/SongMenu.vue';
import { copyDevice } from '../devices/deviceClipboard';
import EffectKnob from './EffectKnob.vue';
import EffectVisual from './EffectVisual.vue';

/**
 * One device of the rack: an effect slot as a card. The head has the power switch (bypass keeps the values), the
 * name, a lit dot while it changes the sound, the face toggle (macro: two or three big knobs with plain names; full:
 * every parameter) and the ⋯ menu (presets, save preset, duplicate, reset, remove). The body shows what the effect does
 * and its knobs. The head is the drag handle: drag to reorder, Alt-drag to copy. Copy in the menu carries it to another channel.
 */
const props = defineProps<{
    effects: Effects;
    slotId: string;
    /** The rack's face; a card can flip its own. */
    face: 'macro' | 'full';
    /** Bumped by the rack after an undo, so the knobs read their values again. */
    version: number;
}>();

const emit = defineEmits<{
    dragstart: [event: DragEvent];
    dragend: [];
}>();

const { user, saveEffectPreset, removeEffectPreset } = usePresets();

const effect = computed(() => props.effects.effectOf(props.slotId)!);
const definition = computed(() => EFFECT_DEFINITIONS[effect.value]);
const info = computed(() => EFFECT_INFO[effect.value]);

/** Bumped when the card sets values itself (a preset, a reset): the knobs re-mount to read them. */
const local = ref(0);
/** Bumped on every change, a knob turned included: the picture and the lit dot follow it. */
const tick = ref(0);
const knobKey = computed(() => `${props.version}-${local.value}`);

const ownFace = ref<'macro' | 'full' | null>(null);
const face = computed(() => ownFace.value ?? props.face);

const label = computed(() => {
    void props.effects.revision;
    return props.effects.slotLabel(props.slotId);
});

const bypassed = computed(() => {
    void props.effects.revision;
    return props.effects.isBypassed(props.slotId);
});

const isOn = computed(() => {
    void props.effects.revision;
    void tick.value;
    void local.value;
    return props.effects.isNeeded(props.slotId);
});

const isIdle = computed(() => {
    void props.effects.revision;
    void tick.value;
    void local.value;
    return !bypassed.value && props.effects.isIdle(props.slotId);
});

const params = computed(() => definition.value.params as readonly EffectParamDefinition[]);
const toggle = computed(() => params.value.find((param) => param.toggle));

/** The knobs this face shows: the macro names over their params, or every param that is not a switch. */
const knobs = computed(() => {
    if (face.value === 'macro') {
        return info.value.macros.map((macro) => ({ param: params.value.find((param) => param.key === macro.key)!, label: macro.label })).filter((knob) => knob.param);
    }
    return params.value.filter((param) => !param.toggle).map((param) => ({ param, label: param.label }));
});

const setBypassed = (value: boolean) => props.effects.setBypassed(props.slotId, value);

/** The limiter's own on/off switch sits next to the power button. */
const switchedOn = computed(() => {
    void local.value;
    return toggle.value ? props.effects.getParam(props.slotId, toggle.value.key) > 0 : true;
});

const flip = () => {
    if (toggle.value) {
        props.effects.setParam(props.slotId, toggle.value.key, switchedOn.value ? 0 : 1);
        local.value++;
    }
};

const applyParams = (values: Readonly<Record<string, number>>) => {
    props.effects.setParams(props.slotId, { ...addedParams(effect.value, props.effects.role), ...values });
    local.value++;
};

/* ---- the menu ---- */

const menu = ref<{ x: number; y: number } | null>(null);
const naming = ref(false);
const presetName = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

const openMenu = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.value = event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom + 4 };
};

const startSaving = async () => {
    presetName.value = label.value;
    naming.value = true;
    await nextTick();
    nameInput.value?.select();
};

const savePreset = () => {
    const name = presetName.value.trim();
    if (name) {
        saveEffectPreset(effect.value, name, props.effects.paramsOf(props.slotId));
    }
    naming.value = false;
};

const menuItems = computed<SongMenuItem[]>(() => {
    const factory = EFFECT_PRESETS[effect.value] ?? [];
    const mine = user.value.effects[effect.value] ?? [];
    return [
        ...factory.map((preset) => ({ label: preset.name, icon: 'mdi:star-four-points-outline', action: () => applyParams(preset.params) })),
        ...(factory.length && mine.length ? [{}] : []),
        ...mine.map((preset) => ({ label: preset.name, icon: 'mdi:account-music-outline', action: () => applyParams(preset.params) })),
        {},
        { label: 'Save as preset…', icon: 'mdi:content-save-outline', action: () => void startSaving() },
        ...mine.map((preset) => ({ label: `Delete "${preset.name}"`, icon: 'mdi:delete-outline', action: () => removeEffectPreset(effect.value, preset.name) })),
        {},
        { label: face.value === 'macro' ? 'Show every knob' : 'Show the main knobs', icon: 'mdi:tune-variant', action: () => (ownFace.value = face.value === 'macro' ? 'full' : 'macro') },
        { label: 'Duplicate', icon: 'mdi:content-duplicate', action: () => props.effects.duplicate(props.slotId) },
        { label: 'Copy (paste on another channel)', icon: 'mdi:content-copy', action: () => copyDevice(props.effects, props.slotId) },
        {
            label: 'Reset',
            icon: 'mdi:restore',
            action: () => {
                props.effects.reset(props.slotId);
                local.value++;
            },
        },
        { label: 'Remove', icon: 'mdi:close', danger: true, action: () => props.effects.remove(props.slotId) },
    ];
});
</script>

<template>
    <article class="device-card" :class="{ 'device-card--full': face === 'full' }" :data-on="isOn" :data-bypassed="bypassed" :data-idle="isIdle" :aria-label="label">
        <header
            class="device-card-head"
            draggable="true"
            v-tooltip.top="{ value: 'Drag to move, Alt+drag to copy', showDelay: 900 }"
            @dragstart="emit('dragstart', $event)"
            @dragend="emit('dragend')"
            @contextmenu.prevent="openMenu"
        >
            <button
                type="button"
                class="device-power"
                :data-on="!bypassed"
                :aria-pressed="!bypassed"
                :aria-label="bypassed ? `Turn ${label} on` : `Bypass ${label}`"
                v-tooltip.top="bypassed ? 'Bypassed: click to turn it back on' : 'On: click to bypass (keeps the settings)'"
                @click="setBypassed(!bypassed)"
            >
                <Icon icon="mdi:power" class="w-4 h-4" />
            </button>
            <Icon :icon="info.icon" class="device-card-icon" />
            <span class="device-card-name">{{ label }}</span>
            <span class="chip-dot" :data-on="isOn" :title="isOn ? 'Changing the sound' : isIdle ? 'Its settings leave the sound as it is' : 'Off'"></span>
            <button v-if="toggle" type="button" class="device-switch" :data-on="switchedOn" :aria-pressed="switchedOn" v-tooltip.top="switchedOn ? 'Limiter on' : 'Limiter off'" @click="flip">
                {{ switchedOn ? 'On' : 'Off' }}
            </button>
            <button type="button" class="iconbtn device-card-menu" :aria-label="`${label} menu`" v-tooltip.top="'Presets and more'" @click="openMenu">
                <Icon icon="mdi:dots-horizontal" class="w-4 h-4" />
            </button>
        </header>

        <div class="device-card-body">
            <EffectVisual :effects="props.effects" :slot-id="props.slotId" :effect="effect" :version="local + tick + props.version" :on="isOn" />
            <p v-if="face === 'macro'" class="device-card-blurb">{{ info.blurb }}</p>
            <div class="device-card-knobs" :key="knobKey">
                <EffectKnob
                    v-for="knob in knobs"
                    :key="knob.param.key"
                    :effects="props.effects"
                    :slot-id="props.slotId"
                    :param="knob.param"
                    :label="knob.label"
                    :size="face === 'macro' ? 52 : 44"
                    @change="tick++"
                />
            </div>
            <form v-if="naming" class="device-card-save" @submit.prevent="savePreset">
                <input ref="nameInput" v-model="presetName" class="input" type="text" maxlength="40" aria-label="Preset name" @keydown.escape.stop="naming = false" />
                <button type="submit" class="iconbtn" aria-label="Save preset"><Icon icon="mdi:check" class="w-4 h-4" /></button>
            </form>
        </div>

        <SongMenu v-if="menu" :items="menuItems" :x="menu.x" :y="menu.y" :title="label" @close="menu = null" />
    </article>
</template>
