import type { Automatable, AutomationTarget } from '@/juicyloops/automation';
import { engine, ENGINE_LATENCY_HINT } from '@/juicyloops/engine';
import { latencyHintFor, readLowLatency, writeLowLatency } from '@/juicyloops/latency';
import { controllerValue, learnMapping, mappingsFor, removeMapping, type MidiMapping } from '@/juicyloops/midi/mappings';
import { parseMidiMessage } from '@/juicyloops/midi/messages';
import { MidiInput, type MidiAccessState, type MidiDevice } from '@/juicyloops/midi/midiInput';
import { MidiRouter, type LiveTrack, type MidiRouterListener } from '@/juicyloops/midi/router';
import { computed, ref, toRaw, watch } from 'vue';
import { useHistory } from './useHistory';
import { useJuicyLoops } from './useJuicyLoops';
import { useMidiLearn } from './useMidiLearn';
import { useWorkspace } from './useWorkspace';

/**
 * MIDI in the studio: the inputs, the router that plays armed tracks, MIDI learn and the latency setting.
 * Module level state: there is one set of MIDI inputs per page.
 *
 * **Recorder hook** (Phase 4 of notes/midi-recording.md): `onMidiEvent(listener)` hands every routed event to the
 * listener: `{ type, input, channel, id, note, velocity, cc, value, timeStamp, time, trackIds }` (see
 * `MidiRouterEvent`). Note-ons and note-offs share `id`; `timeStamp` is the `performance.now()` clock of the message,
 * `time` the context time it was played at; `trackIds` are the tracks it went to (a note-off: the ones its note-on
 * went to). Controllers that drive a learned knob arrive as `cc` events too; `mappingsFor` tells which parameters.
 */

const { containers, currentContainer } = useJuicyLoops();
const { selectedTrack } = useWorkspace();
const { commit, commitWhenQuiet } = useHistory();
const learn = useMidiLearn();

const state = ref<MidiAccessState>('off');
const devices = ref<MidiDevice[]>([]);
/** Bumped by every incoming message, so the indicator can flash. */
const activity = ref(0);

/** The stored "low latency" setting; the context keeps the latency it started with (`ENGINE_LATENCY_HINT`). */
const lowLatency = ref(readLowLatency());
watch(lowLatency, (value) => writeLowLatency(value));
/** True when the setting differs from what the running context was made with: it applies on the next start. */
const latencyNeedsRestart = computed(() => latencyHintFor(lowLatency.value) !== ENGINE_LATENCY_HINT);

/** Whether any track in any container is armed; when none is, the selected track plays MIDI. */
const isAnyArmed = computed(() => containers.value.some((container) => container.tracks.some((track) => track.isArmed)));

/** The container of every track the last `armedTracks` call returned, to wake it before a note. */
const containerOf = new Map<string, string>();

/** The tracks MIDI plays: every armed track of every container, or else the selected one. Raw objects. */
const armedTracks = (): LiveTrack[] => {
    containerOf.clear();
    const armed: LiveTrack[] = [];
    for (const container of containers.value) {
        for (const track of container.tracks) {
            if (track.isArmed) {
                const raw = toRaw(track);
                armed.push(raw);
                containerOf.set(raw.id, container.id);
            }
        }
    }
    const selected = selectedTrack.value;
    if (!armed.length && selected) {
        const raw = toRaw(selected);
        armed.push(raw);
        containerOf.set(raw.id, currentContainer.value.id);
    }
    return armed;
};

const context = engine.transport.context;

const router = new MidiRouter({
    armed: armedTracks,
    now: () => context.currentTime,
    // A note on a sleeping container (hibernation) wakes it first; it stays awake while notes are held.
    wake: (track) => {
        const containerId = containerOf.get(track.id);
        if (containerId) {
            engine.sequencer.wakeForLive(containerId);
        }
    },
});

/** Every routed MIDI event, for the recorder. Returns the function that stops listening. */
const onMidiEvent = (listener: MidiRouterListener): (() => void) => router.subscribe(listener);

/* ---- MIDI learn and learned controllers ---- */

watch(
    () => engine.sequencer.midiMappings,
    (list) => {
        learn.mappings.value = [...list];
    },
    { deep: true, immediate: true },
);

/** What a mapping drives. Tracks through their reactive proxy, so the UI sees the change. */
const ownerOf = (target: AutomationTarget): Automatable | undefined => {
    if (target.kind === 'track') {
        return containers.value.find((container) => container.id === target.containerId)?.tracks.find((track) => track.id === target.trackId);
    }
    return engine.resolveTarget(target);
};

/** A controller moved: learn it, or turn the knobs mapped to it. True when it was used for that. */
const handleController = (cc: number, channel: number, value: number): boolean => {
    const waiting = learn.isLearning.value ? learn.learnTarget.value : null;
    if (waiting) {
        engine.sequencer.setMidiMappings(learnMapping(engine.sequencer.midiMappings, { cc, channel, target: waiting.target, param: waiting.param }));
        learn.learnTarget.value = null;
        commit();
        return true;
    }
    const mapped = mappingsFor(engine.sequencer.midiMappings, cc, channel);
    for (const mapping of mapped) {
        const owner = ownerOf(mapping.target);
        const param = owner?.parameter(mapping.param);
        if (owner && param) {
            const next = controllerValue(param, value);
            owner.setParameter(mapping.param, next);
            learn.announceChange(mapping.target, mapping.param, next);
        }
    }
    if (mapped.length) {
        // A controller gesture is one undo step.
        commitWhenQuiet();
    }
    return mapped.length > 0;
};

const removeMappingAt = (index: number): void => {
    engine.sequencer.setMidiMappings(removeMapping(engine.sequencer.midiMappings, index));
    commit();
};

/** Switches a mapping between its own channel and every channel. */
const setMappingChannel = (index: number, channel: MidiMapping['channel']): void => {
    engine.sequencer.setMidiMappings(engine.sequencer.midiMappings.map((mapping, i) => (i === index ? { ...mapping, channel } : mapping)));
    commit();
};

/* ---- the inputs ---- */

const onMessage = (inputId: string, data: Uint8Array, timeStamp: number): void => {
    const message = parseMidiMessage(data);
    if (!message) {
        return;
    }
    activity.value++;
    if (message.type === 'cc' && handleController(message.controller, message.channel, message.value)) {
        // A learned controller turns its knob; it still reaches the subscribers (the recorder).
        router.handle(inputId, message, timeStamp);
        return;
    }
    if (message.type === 'sustain' && learn.isLearning.value && learn.learnTarget.value) {
        // In learn mode the pedal can be learned like any controller.
        handleController(64, message.channel, message.value);
        return;
    }
    router.handle(inputId, message, timeStamp);
};

const input = new MidiInput({
    onMessage,
    onChange: () => {
        state.value = input.state;
        devices.value = input.devices.map((device) => ({ ...device }));
    },
    onInputGone: (id) => router.allNotesOff(performance.now(), id),
});
state.value = input.state;

/** Asks for MIDI access (from a click). */
const enable = (): Promise<boolean> => input.enable();

/** Turns MIDI on by itself when it was granted on an earlier visit (after the first click of the session). */
const restore = (): Promise<boolean> => input.restore();

const setDeviceEnabled = (id: string, enabled: boolean): void => input.setEnabled(id, enabled);

/** Stops every note MIDI started (a hanging note, a panic). */
const panic = (): void => router.allNotesOff();

export const useMidi = () => ({
    state,
    devices,
    activity,
    enable,
    restore,
    setDeviceEnabled,
    panic,
    isAnyArmed,
    lowLatency,
    activeLatency: ENGINE_LATENCY_HINT,
    latencyNeedsRestart,
    removeMappingAt,
    setMappingChannel,
    onMidiEvent,
    /** The tracks MIDI plays right now (raw objects): the armed ones, or else the selected one. What recording writes into. */
    armedTracks,
    /** The router itself, for tests and the recorder (`handle` plays a parsed message as if it came in). */
    router,
    ...learn,
});
