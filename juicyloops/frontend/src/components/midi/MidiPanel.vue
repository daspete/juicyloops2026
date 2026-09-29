<script setup lang="ts">
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useMidi } from '@/composables/useMidi';
import { paramTitle, type AutomationTarget } from '@/juicyloops/automation';
import { RETURN_NAMES } from '@/juicyloops/sends';
import type { MidiMapping } from '@/juicyloops/midi/mappings';
import { Icon } from '@iconify/vue';
import { Popover, ToggleSwitch } from 'primevue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { TRACK_META } from '../tracks/trackMeta';

/**
 * MIDI in the top bar: a light that shows whether MIDI is on and flashes with incoming messages, the Learn switch
 * (every knob that can be mapped lights up; click one, move a controller), and a popover with the inputs, the
 * learned mappings, the latency setting and a panic button.
 */
const midi = useMidi();
const { containers, engine } = useJuicyLoops();
const { state, devices, activity, isLearning, learnTarget, mappings, lowLatency, latencyNeedsRestart } = midi;

const popover = ref<InstanceType<typeof Popover> | null>(null);
const toggle = (event: Event) => popover.value?.toggle(event);

/* The light flashes for a moment on every message. */
const isFlashing = ref(false);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
watch(activity, () => {
    isFlashing.value = true;
    if (flashTimer) {
        clearTimeout(flashTimer);
    }
    flashTimer = setTimeout(() => (isFlashing.value = false), 120);
});

const isOn = computed(() => state.value === 'on');
const connected = computed(() => devices.value.filter((device) => device.connected));
const listening = computed(() => connected.value.filter((device) => device.enabled).length);

const lightHint = computed(() => {
    switch (state.value) {
        case 'unsupported':
            return 'This browser has no Web MIDI';
        case 'denied':
            return 'MIDI was not allowed. Click to try again';
        case 'on':
            return listening.value ? `MIDI on · ${listening.value} ${listening.value === 1 ? 'input' : 'inputs'}` : 'MIDI on · no input plugged in';
        default:
            return 'MIDI: play tracks from a keyboard, map controllers to knobs';
    }
});

const enable = () => void midi.enable();

const toggleLearn = () => midi.setLearning(!isLearning.value);

const learnLabel = computed(() => (isLearning.value ? (learnTarget.value ? `Move a controller for ${learnTarget.value.label ?? 'the knob'}` : 'Click a knob') : 'Learn'));

/* Escape leaves learn mode. */
const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isLearning.value) {
        midi.setLearning(false);
    }
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey);
    if (flashTimer) {
        clearTimeout(flashTimer);
    }
});

/* ---- the mapping list ---- */

const ownerName = (target: AutomationTarget): string | null => {
    if (target.kind === 'master') {
        return 'Master';
    }
    if (target.kind === 'return') {
        return `Return ${RETURN_NAMES[target.index] ?? target.index + 1}`;
    }
    const container = containers.value.find((candidate) => candidate.id === target.containerId);
    if (!container) {
        return null;
    }
    if (target.kind === 'container') {
        return `${container.name} channel`;
    }
    const index = container.tracks.findIndex((track) => track.id === target.trackId);
    const track = container.tracks[index];
    return track ? `${container.name} · ${TRACK_META[track.type].label} ${index + 1}` : null;
};

const describe = (mapping: MidiMapping) => {
    const owner = ownerName(mapping.target);
    const param = owner ? engine.resolveTarget(mapping.target)?.parameter(mapping.param) : undefined;
    return { owner: owner ?? 'Removed', param: param ? paramTitle(param) : mapping.param, missing: !owner || !param };
};

const rows = computed(() => mappings.value.map((mapping, index) => ({ mapping, index, ...describe(mapping) })));
</script>

<template>
    <div class="midibar">
        <button
            type="button"
            class="chip midichip"
            :data-state="state"
            :data-flash="isFlashing"
            :aria-label="lightHint"
            aria-haspopup="dialog"
            v-tooltip.bottom="lightHint"
            @click="toggle"
        >
            <span class="midichip-light" aria-hidden="true"></span>
            <Icon icon="mdi:midi" class="w-4 h-4" />
            <span class="midibar-label">MIDI</span>
        </button>
        <button
            v-if="isOn"
            type="button"
            class="chip midilearn"
            :data-active="isLearning"
            :aria-pressed="isLearning"
            :aria-label="learnLabel"
            v-tooltip.bottom="isLearning ? `${learnLabel}. Click or Esc to leave learn mode` : 'Learn: click a knob, then move a controller to map it'"
            @click="toggleLearn"
        >
            <Icon icon="mdi:link-variant" class="w-4 h-4" />
            <span class="midibar-label">{{ learnLabel }}</span>
        </button>

        <Popover ref="popover">
            <div class="midipop" role="dialog" aria-label="MIDI">
                <section class="midipop-section">
                    <header class="midipop-head">
                        <span class="eyebrow">MIDI inputs</span>
                        <button v-if="isOn" type="button" class="iconbtn iconbtn--tiny" v-tooltip.bottom="'Stop every note MIDI started'" @click="midi.panic()">
                            <Icon icon="mdi:stop-circle-outline" class="w-3.5 h-3.5" />
                            <span>All notes off</span>
                        </button>
                    </header>
                    <p v-if="state === 'unsupported'" class="midipop-note">This browser has no Web MIDI. Chrome, Edge and Firefox have it.</p>
                    <template v-else-if="!isOn">
                        <p class="midipop-note">
                            {{ state === 'denied' ? 'The browser did not allow MIDI. Check the site permissions, then try again.' : 'Play armed tracks from a keyboard and map controllers to knobs.' }}
                        </p>
                        <button type="button" class="chip" :disabled="state === 'requesting'" @click="enable">
                            <Icon icon="mdi:midi-port" class="w-4 h-4" />
                            <span>{{ state === 'requesting' ? 'Asking the browser…' : 'Enable MIDI' }}</span>
                        </button>
                    </template>
                    <template v-else>
                        <p v-if="!devices.length" class="midipop-note">No MIDI input found. Plug one in; it shows up here.</p>
                        <label v-for="device in devices" :key="device.id" class="midipop-device" :data-connected="device.connected">
                            <ToggleSwitch
                                :model-value="device.enabled"
                                :aria-label="`Listen to ${device.name}`"
                                @update:model-value="midi.setDeviceEnabled(device.id, $event)"
                            />
                            <span class="midipop-device-name">{{ device.name }}</span>
                            <span class="midipop-device-note">{{ device.connected ? device.manufacturer : 'unplugged' }}</span>
                        </label>
                        <p class="midipop-note">Every armed track plays, on any channel, and so does the selected track. Recording goes into the armed tracks, or into the selected one when none is armed.</p>
                    </template>
                </section>

                <section v-if="isOn || rows.length" class="midipop-section">
                    <header class="midipop-head">
                        <span class="eyebrow">Learned controllers</span>
                    </header>
                    <p v-if="!rows.length" class="midipop-note">None yet. Switch on Learn, click a knob, move a controller.</p>
                    <ul v-else class="midipop-maps">
                        <li v-for="row in rows" :key="row.index" class="midipop-map" :data-missing="row.missing">
                            <span class="midipop-cc">CC {{ row.mapping.cc }}</span>
                            <button
                                type="button"
                                class="iconbtn iconbtn--tiny font-mono"
                                v-tooltip.bottom="row.mapping.channel === 'all' ? 'Listens on every channel. Click for one channel' : 'Listens on this channel only. Click for every channel'"
                                @click="midi.setMappingChannel(row.index, row.mapping.channel === 'all' ? 0 : 'all')"
                            >
                                {{ row.mapping.channel === 'all' ? 'any ch' : `ch ${row.mapping.channel + 1}` }}
                            </button>
                            <span class="midipop-target">
                                <span>{{ row.param }}</span>
                                <small>{{ row.owner }}</small>
                            </span>
                            <button type="button" class="iconbtn iconbtn--tiny iconbtn--danger" aria-label="Remove mapping" v-tooltip.bottom="'Remove'" @click="midi.removeMappingAt(row.index)">
                                <Icon icon="mdi:close" class="w-3.5 h-3.5" />
                            </button>
                        </li>
                    </ul>
                </section>

                <section class="midipop-section">
                    <label class="midipop-device">
                        <ToggleSwitch v-model="lowLatency" aria-label="Low latency" />
                        <span class="midipop-device-name">Low latency</span>
                        <span class="midipop-device-note">for playing live</span>
                    </label>
                    <p class="midipop-note">
                        A smaller audio buffer, so keys sound sooner. Turn it off if the sound crackles.
                        <strong v-if="latencyNeedsRestart">Takes effect the next time you start JuicyLoops (reload the page).</strong>
                    </p>
                </section>
            </div>
        </Popover>
    </div>
</template>
