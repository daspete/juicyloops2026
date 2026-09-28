<script setup lang="ts">
import { useRecorder } from '@/composables/useRecorder';
import { clampOffset, MAX_RECORD_OFFSET_MS } from '@/juicyloops/midi/recordSettings';
import { Icon } from '@iconify/vue';
import { Popover, ToggleSwitch, useToast } from 'primevue';
import { computed, ref } from 'vue';

/**
 * The Record button next to play/stop, and its options: replace or overdub, the count-in, the metronome (while
 * recording, or whenever playing) and the record offset. The options are saved in this browser.
 */
const recorder = useRecorder();
const { state, countInBeat, settings } = recorder;
const toast = useToast();

const popover = ref<InstanceType<typeof Popover> | null>(null);
const toggleOptions = (event: Event) => popover.value?.toggle(event);

const onRecord = () => {
    if (recorder.toggle() === 'no-track') {
        toast.add({ severity: 'warn', summary: 'Nothing to record into', detail: 'Add a track, then arm it (or select it) to record.', life: 3500 });
    }
};

const hint = computed(() => {
    switch (state.value) {
        case 'countin':
            return 'Counting in… (R cancels)';
        case 'recording':
            return 'Recording. R stops recording and keeps playing, space stops both';
        default:
            return settings.countIn ? 'Record (R): one bar of count-in, then the armed tracks record' : 'Record (R): the armed tracks record what you play';
    }
});

const setOffset = (value: number) => {
    settings.offsetMs = clampOffset(value);
};

const onOffsetInput = (event: Event) => setOffset(Number((event.target as HTMLInputElement).value));
</script>

<template>
    <div class="recorder">
        <button type="button" class="recordbtn" :data-state="state" :aria-pressed="state !== 'off'" :aria-label="state === 'off' ? 'Record' : 'Stop recording'" v-tooltip.bottom="hint" @click="onRecord">
            <span v-if="state === 'countin'" class="recordbtn-count">{{ countInBeat || '·' }}</span>
            <span v-else class="recordbtn-dot" aria-hidden="true"></span>
        </button>
        <button type="button" class="iconbtn iconbtn--tiny recorder-more" aria-label="Recording options" aria-haspopup="dialog" v-tooltip.bottom="'Recording options'" @click="toggleOptions">
            <Icon icon="mdi:chevron-down" class="w-3.5 h-3.5" />
        </button>

        <Popover ref="popover">
            <div class="midipop recpop" role="dialog" aria-label="Recording options">
                <section class="midipop-section">
                    <header class="midipop-head">
                        <span class="eyebrow">Recording</span>
                    </header>
                    <label class="midipop-device">
                        <ToggleSwitch v-model="settings.replace" aria-label="Replace" />
                        <span class="midipop-device-name">Replace</span>
                        <span class="midipop-device-note">{{ settings.replace ? 'first pass replaces' : 'off: overdub' }}</span>
                    </label>
                    <label class="midipop-device">
                        <ToggleSwitch v-model="settings.countIn" aria-label="Count-in" />
                        <span class="midipop-device-name">Count-in</span>
                        <span class="midipop-device-note">one bar</span>
                    </label>
                    <label class="midipop-device">
                        <ToggleSwitch v-model="settings.metronome" aria-label="Metronome while recording" />
                        <span class="midipop-device-name">Metronome</span>
                        <span class="midipop-device-note">while recording</span>
                    </label>
                    <label class="midipop-device">
                        <ToggleSwitch v-model="settings.metronomeWhilePlaying" aria-label="Metronome while playing" />
                        <span class="midipop-device-name">Metronome while playing</span>
                        <span class="midipop-device-note">always</span>
                    </label>
                    <p class="midipop-note">
                        Armed tracks record what you play on MIDI, as played (Quantize tidies it up). Learned controllers and the pitch wheel record into the
                        track's automation. The metronome is only in your speakers, never in an export.
                    </p>
                </section>
                <section class="midipop-section">
                    <div class="recpop-offset">
                        <span class="midipop-device-name">Record offset</span>
                        <button type="button" class="iconbtn iconbtn--tiny" aria-label="Earlier" @click="setOffset(settings.offsetMs - 1)">
                            <Icon icon="mdi:minus" class="w-3.5 h-3.5" />
                        </button>
                        <input
                            class="recpop-offset-input"
                            type="number"
                            :min="-MAX_RECORD_OFFSET_MS"
                            :max="MAX_RECORD_OFFSET_MS"
                            :value="settings.offsetMs"
                            aria-label="Record offset in milliseconds"
                            @change="onOffsetInput"
                        />
                        <span class="midipop-device-note">ms</span>
                        <button type="button" class="iconbtn iconbtn--tiny" aria-label="Later" @click="setOffset(settings.offsetMs + 1)">
                            <Icon icon="mdi:plus" class="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <p class="midipop-note">If recorded notes land consistently early or late, move them: negative is earlier, positive later.</p>
                </section>
            </div>
        </Popover>
    </div>
</template>
