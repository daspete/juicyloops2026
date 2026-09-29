<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed } from 'vue';
import { containerChannel, masterChannel, returnChannel, trackChannels } from '@/composables/useChannels';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import ChannelStrip from './ChannelStrip.vue';

/**
 * The mixer rack: every channel of the session as a strip, in signal order from left to right.
 *
 * Each container is a group: its track strips, then its own channel (every track sums into it). A group folds down to
 * its channel strip. Then come the returns A and B (what the sends feed), the song lanes (mute and solo only: lanes
 * carry no audio of their own) and, pinned to the right edge, the master.
 *
 * Quick mode shows only the current container's tracks and the master, with simple strips.
 */
const { containers, currentContainer, selectContainer, song } = useJuicyLoops();
const { isPro, dock, isFolded, toggleFolded, toggleNarrow } = useWorkspace();

const narrow = computed(() => dock.value.narrow);

const groups = computed(() =>
    (isPro.value ? containers.value : [currentContainer.value]).map((container) => ({
        container,
        channel: containerChannel(container),
        tracks: trackChannels(container),
        folded: isPro.value && isFolded(container.id),
        current: container.id === currentContainer.value.id,
    })),
);

const returns = computed(() => [returnChannel(0), returnChannel(1)]);
const master = masterChannel();

const anyLaneSolo = computed(() => song.value.lanes.some((lane) => lane.isSolo));

const foldAll = (fold: boolean) => {
    for (const group of groups.value) {
        if (group.folded !== fold) {
            toggleFolded(group.container.id);
        }
    }
};
</script>

<template>
    <div class="mixer" :class="{ 'mixer--narrow': narrow, 'mixer--simple': !isPro }">
        <div class="mixer-tools">
            <button type="button" class="iconbtn" :data-active="narrow" :aria-pressed="narrow" v-tooltip.top="narrow ? 'Wide strips' : 'Narrow strips: more channels on screen'" @click="toggleNarrow">
                <Icon :icon="narrow ? 'mdi:arrow-expand-horizontal' : 'mdi:arrow-collapse-horizontal'" class="w-4 h-4" />
            </button>
            <template v-if="isPro">
                <button type="button" class="iconbtn" v-tooltip.top="'Fold every container to its channel'" @click="foldAll(true)">
                    <Icon icon="mdi:unfold-less-vertical" class="w-4 h-4" />
                </button>
                <button type="button" class="iconbtn" v-tooltip.top="'Unfold every container'" @click="foldAll(false)">
                    <Icon icon="mdi:unfold-more-vertical" class="w-4 h-4" />
                </button>
            </template>
        </div>

        <div class="mixer-scroll">
            <section
                v-for="group in groups"
                :key="group.container.id"
                class="mixer-group"
                :data-current="group.current"
                :data-folded="group.folded"
                :aria-label="`Container ${group.container.name}`"
            >
                <header class="mixer-group-head">
                    <button v-if="isPro" type="button" class="mixer-fold" :aria-expanded="!group.folded" v-tooltip.top="group.folded ? 'Show the tracks' : 'Fold to the channel'" @click="toggleFolded(group.container.id)">
                        <Icon :icon="group.folded ? 'mdi:chevron-right' : 'mdi:chevron-down'" class="w-4 h-4" />
                    </button>
                    <button type="button" class="mixer-group-name" :title="group.current ? 'The container you are editing' : 'Edit this container'" @click="selectContainer(group.container.id)">
                        {{ group.container.name }}
                    </button>
                    <span class="mixer-group-count">{{ group.tracks.length }} {{ group.tracks.length === 1 ? 'track' : 'tracks' }}</span>
                </header>
                <div class="mixer-group-strips">
                    <template v-if="!group.folded">
                        <ChannelStrip v-for="channel in group.tracks" :key="channel.key" :channel="channel" :narrow="narrow" :simple="!isPro" />
                        <div v-if="!group.tracks.length" class="mixer-empty">No tracks yet</div>
                    </template>
                    <ChannelStrip v-if="isPro" :channel="group.channel" :narrow="narrow" class="mstrip--bus" />
                </div>
            </section>

            <section v-if="isPro" class="mixer-group mixer-group--returns" aria-label="Returns">
                <header class="mixer-group-head">
                    <span class="mixer-group-name mixer-group-name--static">Returns</span>
                    <span class="mixer-group-count">fed by the sends</span>
                </header>
                <div class="mixer-group-strips">
                    <ChannelStrip v-for="channel in returns" :key="channel.key" :channel="channel" :narrow="narrow" />
                </div>
            </section>

            <section v-if="isPro && song.lanes.length" class="mixer-group mixer-group--lanes" aria-label="Song lanes">
                <header class="mixer-group-head">
                    <span class="mixer-group-name mixer-group-name--static">Song lanes</span>
                    <span class="mixer-group-count">mute &amp; solo</span>
                </header>
                <div class="mixer-group-strips">
                    <div v-for="lane in song.lanes" :key="lane.id" class="lanestrip" :data-silent="anyLaneSolo ? !lane.isSolo : lane.isMuted">
                        <Icon icon="mdi:view-sequential-outline" class="w-4 h-4" />
                        <span class="lanestrip-name" :title="lane.name">{{ lane.name }}</span>
                        <span class="lanestrip-clips">{{ lane.clips.length }} clips</span>
                        <div class="mstrip-switches">
                            <button type="button" class="mstrip-switch mstrip-switch--mute" :data-active="lane.isMuted" :aria-pressed="lane.isMuted" v-tooltip.top="'Mute this lane'" @click="lane.isMuted = !lane.isMuted">M</button>
                            <button type="button" class="mstrip-switch mstrip-switch--solo" :data-active="!!lane.isSolo" :aria-pressed="!!lane.isSolo" v-tooltip.top="'Solo this lane'" @click="lane.isSolo = !lane.isSolo">S</button>
                        </div>
                    </div>
                </div>
            </section>
        </div>

        <div class="mixer-master">
            <ChannelStrip :channel="master" :narrow="narrow" :simple="!isPro" class="mstrip--master" />
        </div>
    </div>
</template>
