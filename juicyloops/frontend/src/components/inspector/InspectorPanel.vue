<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import { channelOf, trackName, type ChannelModel } from '@/composables/useChannels';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { provideLearnOwner, useMidiLearn } from '@/composables/useMidiLearn';
import { useWorkspace } from '@/composables/useWorkspace';
import { paramTitle, sameTarget } from '@/juicyloops/automation';
import { RETURN_NAMES, SEND_OFF } from '@/juicyloops/sends';
import TrackPatternSettings from '../tracks/settings/TrackPatternSettings.vue';
import TrackVoiceSettings from '../tracks/settings/TrackVoiceSettings.vue';
import { TRACK_META } from '../tracks/trackMeta';

/**
 * The Inspector, docked on the right: everything about the selected channel that is not its sound. Its name, the
 * switches, the pattern tools of a track, how its notes behave, where it goes (output and sends), what drives it
 * (automation lanes, MIDI mappings). Sections fold, so several can stay open at once. The sound itself, the instrument
 * and the effects, is in the device rack at the bottom.
 */
const { containers, selectContainer, engine } = useJuicyLoops();
const { selectedChannel, selectChannel, toggleInspector, openDock, isPro } = useWorkspace();
const { mappings } = useMidiLearn();

const channel = computed<ChannelModel | null>(() => (selectedChannel.value ? channelOf(selectedChannel.value) : null));
provideLearnOwner(computed(() => channel.value?.target ?? null));

const track = computed(() => channel.value?.track ?? null);
const container = computed(() => channel.value?.container ?? null);

const rename = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();
    if (track.value) {
        track.value.name = value;
    } else if (channel.value?.kind === 'container' && container.value && value) {
        container.value.name = value;
    }
    input.value = channel.value?.name ?? '';
};

const canRename = computed(() => channel.value?.kind === 'track' || channel.value?.kind === 'container');

/** Where this channel's sound goes next. */
const output = computed(() => {
    switch (channel.value?.kind) {
        case 'track':
            return `${container.value?.name ?? 'Container'} channel`;
        case 'master':
            return 'Your speakers';
        default:
            return 'Master';
    }
});

/** Which channels send to a return (for a return's page). */
const feeders = computed(() => {
    const target = channel.value?.target;
    if (target?.kind !== 'return') {
        return [];
    }
    const index = target.index;
    return containers.value.flatMap((candidate) => [
        ...candidate.tracks
            .map((item, trackIndex) => ({ item, trackIndex }))
            .filter(({ item }) => (item.sends.levels[index] ?? SEND_OFF) > SEND_OFF)
            .map(({ item, trackIndex }) => ({ label: `${candidate.name} › ${trackName(item, trackIndex)}`, target: { kind: 'track' as const, containerId: candidate.id, trackId: item.id } })),
        ...((candidate.bus.sends?.levels[index] ?? SEND_OFF) > SEND_OFF ? [{ label: `${candidate.name} channel`, target: { kind: 'container' as const, containerId: candidate.id } }] : []),
    ]);
});

/** Parameters of this channel drawn by automation: a track's own lanes and the song's lanes that point here. */
const automated = computed(() => {
    const current = channel.value;
    if (!current) {
        return [];
    }
    const owner = engine.resolveTarget(current.target);
    const own = track.value ? track.value.automation.lanes.map((lane) => ({ param: lane.param, where: 'Track lane' })) : [];
    const song = engine.song.automation.filter((lane) => sameTarget(lane.target, current.target)).map((lane) => ({ param: lane.param, where: 'Song lane' }));
    return [...own, ...song].map(({ param, where }) => {
        const definition = owner?.parameter(param);
        return { key: `${where}-${param}`, label: definition ? paramTitle(definition) : param, where };
    });
});

const learned = computed(() => {
    const current = channel.value;
    return current ? mappings.value.filter((mapping) => sameTarget(mapping.target, current.target)) : [];
});

const containerTracks = computed(() => (channel.value?.kind === 'container' && container.value ? container.value.tracks.map((item, index) => ({ item, index })) : []));

const describeSend = (level: number) => (level <= SEND_OFF ? 'Off' : `${level > 0 ? '+' : ''}${level.toFixed(1)} dB`);
</script>

<template>
    <aside class="dock dock--right inspector" :style="{ '--jl-accent': channel?.accent ?? 'var(--jl-brand)' }" aria-label="Inspector">
        <header class="dock-bar">
            <Icon icon="mdi:information-outline" class="w-4 h-4" />
            <span class="dock-title">Inspector</span>
            <div class="flex-1"></div>
            <button type="button" class="iconbtn" aria-label="Close the Inspector" v-tooltip.bottom="'Close (I)'" @click="toggleInspector">
                <Icon icon="mdi:close" class="w-4 h-4" />
            </button>
        </header>

        <div v-if="!channel" class="dock-body">
            <div class="detail-empty">
                <Icon icon="mdi:cursor-default-click-outline" class="w-6 h-6" />
                <span>Select a track, or a strip in the mixer. Its settings show up here.</span>
            </div>
        </div>

        <div v-else class="dock-body inspector-body">
            <div class="inspector-id">
                <span class="track-badge"><Icon :icon="channel.icon" class="w-4 h-4" /></span>
                <div class="inspector-id-text">
                    <span class="eyebrow">{{ channel.role }}</span>
                    <input
                        v-if="canRename"
                        :key="channel.key"
                        class="inspector-name"
                        type="text"
                        :value="channel.name"
                        maxlength="40"
                        spellcheck="false"
                        :aria-label="`Name of ${channel.name}`"
                        :placeholder="track ? `${TRACK_META[track.type].label}` : 'Name'"
                        @change="rename"
                        @keydown.enter="($event.target as HTMLInputElement).blur()"
                    />
                    <span v-else class="inspector-name inspector-name--static">{{ channel.name }}</span>
                </div>
            </div>

            <div class="inspector-actions">
                <button type="button" class="chip" @click="openDock('devices')"><Icon icon="mdi:tune-variant" class="w-4 h-4" /> Devices</button>
                <button type="button" class="chip" @click="openDock('mixer')"><Icon icon="mdi:tune-vertical" class="w-4 h-4" /> Mixer</button>
                <span class="flex-1"></span>
                <button type="button" class="mstrip-switch mstrip-switch--mute" :data-active="channel.isMuted" :aria-pressed="channel.isMuted" v-tooltip.bottom="'Mute'" @click="channel.toggleMute()">M</button>
                <button
                    v-if="channel.canSolo"
                    type="button"
                    class="mstrip-switch mstrip-switch--solo"
                    :data-active="channel.isSolo"
                    :aria-pressed="channel.isSolo"
                    v-tooltip.bottom="'Solo'"
                    @click="channel.toggleSolo()"
                >
                    S
                </button>
            </div>

            <details v-if="track" class="inspector-section" open>
                <summary><Icon icon="mdi:dots-grid" class="w-4 h-4" /> Pattern</summary>
                <div class="settings">
                    <TrackPatternSettings :track="track" />
                </div>
            </details>

            <details v-if="track" class="inspector-section" open>
                <summary><Icon icon="mdi:music-note-outline" class="w-4 h-4" /> Notes</summary>
                <div class="settings">
                    <TrackVoiceSettings :track="track" />
                    <div class="setting">
                        <div class="setting-label">MIDI input</div>
                        <div class="setting-row">
                            <button type="button" class="iconbtn" :data-active="track.isArmed" :aria-pressed="track.isArmed" @click="track.setArmed(!track.isArmed)">
                                <Icon icon="mdi:record-circle-outline" class="w-5 h-5" />
                                <span>{{ track.isArmed ? 'Armed' : 'Arm' }}</span>
                            </button>
                            <span class="setting-hint">Play and record it from a MIDI keyboard</span>
                        </div>
                    </div>
                </div>
            </details>

            <details v-if="containerTracks.length || channel.kind === 'container'" class="inspector-section" open>
                <summary><Icon icon="mdi:view-grid-outline" class="w-4 h-4" /> Tracks in here</summary>
                <ul class="inspector-list">
                    <li v-for="entry in containerTracks" :key="entry.item.id">
                        <button
                            type="button"
                            class="inspector-link"
                            @click="
                                selectContainer(container!.id);
                                selectChannel({ kind: 'track', containerId: container!.id, trackId: entry.item.id });
                            "
                        >
                            <Icon :icon="TRACK_META[entry.item.type].icon" class="w-4 h-4" :style="{ color: TRACK_META[entry.item.type].accent }" />
                            {{ trackName(entry.item, entry.index) }}
                        </button>
                    </li>
                    <li v-if="!containerTracks.length" class="setting-hint">No tracks yet.</li>
                </ul>
            </details>

            <details v-if="isPro" class="inspector-section" open>
                <summary><Icon icon="mdi:source-branch" class="w-4 h-4" /> Routing</summary>
                <dl class="inspector-facts">
                    <dt>Output</dt>
                    <dd>{{ output }}</dd>
                    <template v-if="channel.sends">
                        <template v-for="(level, index) in channel.sends" :key="index">
                            <dt>Send {{ RETURN_NAMES[index] }}</dt>
                            <dd>
                                <button type="button" class="inspector-link" @click="selectChannel({ kind: 'return', index })">{{ describeSend(level) }} → Return {{ RETURN_NAMES[index] }}</button>
                            </dd>
                        </template>
                    </template>
                    <template v-if="channel.kind === 'return'">
                        <dt>Fed by</dt>
                        <dd>
                            <span v-if="!feeders.length" class="setting-hint">Nothing sends here yet. Turn up a Send {{ RETURN_NAMES[channel.target.kind === 'return' ? channel.target.index : 0] }} knob on a strip.</span>
                            <button v-for="feeder in feeders" :key="feeder.label" type="button" class="inspector-link" @click="selectChannel(feeder.target)">{{ feeder.label }}</button>
                        </dd>
                    </template>
                </dl>
            </details>

            <details v-if="isPro" class="inspector-section">
                <summary><Icon icon="mdi:chart-bell-curve" class="w-4 h-4" /> Automation &amp; MIDI <span class="inspector-count">{{ automated.length + learned.length }}</span></summary>
                <ul class="inspector-list">
                    <li v-for="item in automated" :key="item.key"><Icon icon="mdi:vector-polyline" class="w-4 h-4" /> {{ item.label }} <small>{{ item.where }}</small></li>
                    <li v-for="(mapping, index) in learned" :key="`cc-${index}`">
                        <Icon icon="mdi:knob" class="w-4 h-4" /> CC {{ mapping.cc }} → {{ engine.resolveTarget(mapping.target)?.parameter(mapping.param)?.label ?? mapping.param }}
                    </li>
                    <li v-if="!automated.length && !learned.length" class="setting-hint">Nothing automated yet. Map a controller with MIDI learn in the top bar, or draw lanes from a track's Automate button or the song view.</li>
                </ul>
            </details>

            <details class="inspector-section inspector-section--tips">
                <summary><Icon icon="mdi:lightbulb-on-outline" class="w-4 h-4" /> Tips</summary>
                <ul class="inspector-list inspector-tips">
                    <li><kbd>D</kbd> devices, <kbd>M</kbd> mixer, <kbd>I</kbd> this Inspector</li>
                    <li>Double-click a knob or fader to reset it; hold <kbd>Shift</kbd> while dragging for fine moves.</li>
                    <li>Solo (<b>S</b>) on any strip mutes everything else; returns stay on, so the reverb keeps ringing.</li>
                    <li>Sends feed the returns: A holds a reverb, B an echo. Several tracks can share them.</li>
                </ul>
            </details>
        </div>
    </aside>
</template>
