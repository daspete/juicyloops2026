<script setup lang="ts">
import { Button, Dialog } from 'primevue';
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useExport, DEFAULT_TAIL, REPEAT_OPTIONS, type ExportMethod, type ExportSettings } from '@/composables/useExport';
import { useJuicyLoops } from '@/composables/useJuicyLoops';
import { useWorkspace } from '@/composables/useWorkspace';
import { DEFAULT_MP3_BITRATE, EXPORT_FORMATS, MP3_BITRATES, type ExportFormat } from '@/juicyloops/encode';
import type { RenderScope } from '@/juicyloops/render';
import { TRACK_META } from './tracks/trackMeta';

/**
 * Bounce the song, one container or one track to a file. Opened from the file bar (Ctrl+E) or a track head;
 * the latter preselects that track. Fast renders offline; Real time plays the scope once and records it, the only
 * way to catch plugins that are silent offline, so it is preselected whenever the scope has one.
 */

const emit = defineEmits<{ done: [result: { ok: true; fileName: string; seconds: number } | { ok: false; error: string }] }>();

const { isDialogOpen, request, closeDialog, isExporting, progress, preview, exportAudio, cancelExport } = useExport();
const { containers, currentContainer, song } = useJuicyLoops();
const { isPro } = useWorkspace();

type ScopeKind = RenderScope['kind'];

const kind = ref<ScopeKind>('container');
const containerId = ref(currentContainer.value.id);
const trackId = ref<string | null>(null);
const repeats = ref(1);
const tail = ref(DEFAULT_TAIL);
const format = ref<ExportFormat>('wav');
const bitrate = ref(DEFAULT_MP3_BITRATE);
const method = ref<ExportMethod>('offline');

const METHODS: readonly { key: ExportMethod; label: string; icon: string }[] = [
    { key: 'offline', label: 'Fast (offline)', icon: 'mdi:lightning-bolt-outline' },
    { key: 'live', label: 'Real time', icon: 'mdi:record-circle-outline' },
];

const TAILS: readonly number[] = [0, 0.5, 1, 2, 4, 8];

const container = computed(() => containers.value.find((candidate) => candidate.id === containerId.value) ?? currentContainer.value);
const tracks = computed(() => container.value.tracks);

/** The song only exists in Pro; a lone container is not worth a choice, it is what "Loop" means. */
const kinds = computed<{ key: ScopeKind; label: string; icon: string; hint: string; disabled?: boolean }[]>(() => [
    ...(isPro.value ? [{ key: 'song' as const, label: 'Song', icon: 'mdi:view-sequential-outline', hint: 'The whole arrangement, once', disabled: song.value.isEmpty }] : []),
    { key: 'container', label: 'Loop', icon: 'mdi:dots-grid', hint: 'Every track of a container, looping' },
    { key: 'track', label: 'Track', icon: 'mdi:playlist-music-outline', hint: 'One track on its own, looping' },
]);

const trackLabel = (index: number) => `${TRACK_META[tracks.value[index]!.type].label} ${index + 1}`;

/* Every time the dialog opens it starts from what it was opened for, or from the container on screen. */
watch(request, (value) => {
    if (!value) {
        return;
    }
    const preset = value.scope;
    kind.value = preset?.kind ?? (isPro.value && !song.value.isEmpty ? 'song' : 'container');
    containerId.value = preset && preset.kind !== 'song' ? preset.containerId : currentContainer.value.id;
    trackId.value = preset?.kind === 'track' ? preset.trackId : (tracks.value[0]?.id ?? null);
    repeats.value = preset && preset.kind !== 'song' ? preset.repeats : 1;
    method.value = liveOnly.value.length ? 'live' : 'offline';
});

/* A track choice that no longer fits its container falls back to the first one. */
watch(tracks, (list) => {
    if (!list.some((track) => track.id === trackId.value)) {
        trackId.value = list[0]?.id ?? null;
    }
});

const scope = computed<RenderScope | null>(() => {
    if (kind.value === 'song') {
        return { kind: 'song' };
    }
    if (kind.value === 'container') {
        return { kind: 'container', containerId: container.value.id, repeats: repeats.value };
    }
    return trackId.value ? { kind: 'track', containerId: container.value.id, trackId: trackId.value, repeats: repeats.value } : null;
});

const outlook = computed(() => (scope.value ? preview(scope.value, tail.value) : { error: 'Add a track first.' }));
const canExport = computed(() => !isExporting.value && scope.value !== null && 'seconds' in outlook.value);

/** Plugins in the scope that a fast export would leave silent. */
const liveOnly = computed(() => ('liveOnly' in outlook.value ? outlook.value.liveOnly : []));

/* A scope that gains such a plugin (another track or container picked) switches to real time; it never switches back by itself. */
watch(
    () => liveOnly.value.length > 0,
    (needsLive) => {
        if (needsLive && !isExporting.value) {
            method.value = 'live';
        }
    },
);

const methodNote = computed(() => {
    if (method.value === 'live') {
        return 'Plays the export once, out loud, and records it: takes as long as the audio, but every plugin is heard.';
    }
    const names = liveOnly.value;
    return names.length ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} silent in a fast export; choose Real time.` : 'Renders in the background, faster than playing it.';
});

const seconds = (value: number) => {
    const minutes = Math.floor(value / 60);
    const rest = value - minutes * 60;
    return minutes ? `${minutes}:${rest.toFixed(1).padStart(4, '0')} min` : `${rest.toFixed(1)} s`;
};

const submit = async () => {
    if (!scope.value || !canExport.value) {
        return;
    }
    const settings: ExportSettings = { scope: scope.value, format: format.value, tail: tail.value, bitrate: bitrate.value, method: method.value };
    const result = await exportAudio(settings);
    emit('done', result);
    if (result.ok) {
        closeDialog();
    }
};

const onVisible = (visible: boolean) => {
    if (!visible && !isExporting.value) {
        closeDialog();
    }
};
</script>

<template>
    <Dialog
        :visible="isDialogOpen"
        modal
        dismissable-mask
        :closable="!isExporting"
        :close-on-escape="!isExporting"
        header="Export audio"
        class="export-dialog"
        :style="{ width: '30rem' }"
        :breakpoints="{ '640px': '100vw' }"
        @update:visible="onVisible"
    >
        <form class="export" @submit.prevent="submit">
            <fieldset class="export-group" :disabled="isExporting">
                <legend class="export-label">What</legend>
                <div class="export-kinds" role="radiogroup">
                    <button
                        v-for="option in kinds"
                        :key="option.key"
                        type="button"
                        class="export-kind"
                        role="radio"
                        :aria-checked="kind === option.key"
                        :data-active="kind === option.key"
                        :disabled="option.disabled"
                        v-tooltip.bottom="{ value: option.disabled ? 'The song is empty' : option.hint, showDelay: 400 }"
                        @click="kind = option.key"
                    >
                        <Icon :icon="option.icon" class="w-4 h-4" />
                        <span>{{ option.label }}</span>
                    </button>
                </div>

                <div v-if="kind !== 'song'" class="export-row">
                    <label v-if="isPro && containers.length > 1" class="export-field">
                        <span>Container</span>
                        <select v-model="containerId" class="select">
                            <option v-for="candidate in containers" :key="candidate.id" :value="candidate.id">{{ candidate.name }}</option>
                        </select>
                    </label>
                    <label v-if="kind === 'track'" class="export-field">
                        <span>Track</span>
                        <select v-model="trackId" class="select" :disabled="!tracks.length">
                            <option v-if="!tracks.length" :value="null">No tracks</option>
                            <option v-for="(track, index) in tracks" :key="track.id" :value="track.id">{{ trackLabel(index) }}</option>
                        </select>
                    </label>
                    <label class="export-field">
                        <span>Repeats</span>
                        <select v-model.number="repeats" class="select">
                            <option v-for="count in REPEAT_OPTIONS" :key="count" :value="count">{{ count }}×</option>
                        </select>
                    </label>
                </div>
            </fieldset>

            <fieldset class="export-group" :disabled="isExporting">
                <legend class="export-label">How</legend>
                <div class="export-kinds" role="radiogroup">
                    <button
                        v-for="option in METHODS"
                        :key="option.key"
                        type="button"
                        class="export-kind"
                        role="radio"
                        :aria-checked="method === option.key"
                        :data-active="method === option.key"
                        @click="method = option.key"
                    >
                        <Icon :icon="option.icon" class="w-4 h-4" />
                        <span>{{ option.label }}</span>
                    </button>
                </div>
                <p class="export-note" :data-warn="method === 'offline' && liveOnly.length > 0">{{ methodNote }}</p>
            </fieldset>

            <fieldset class="export-group" :disabled="isExporting">
                <legend class="export-label">File</legend>
                <div class="export-kinds" role="radiogroup">
                    <button
                        v-for="option in EXPORT_FORMATS"
                        :key="option.key"
                        type="button"
                        class="export-kind"
                        role="radio"
                        :aria-checked="format === option.key"
                        :data-active="format === option.key"
                        v-tooltip.bottom="{ value: option.hint, showDelay: 400 }"
                        @click="format = option.key"
                    >
                        <span>{{ option.label }}</span>
                    </button>
                </div>
                <div class="export-row">
                    <label v-if="format === 'mp3'" class="export-field">
                        <span>Bitrate</span>
                        <select v-model.number="bitrate" class="select">
                            <option v-for="rate in MP3_BITRATES" :key="rate" :value="rate">{{ rate }} kbps</option>
                        </select>
                    </label>
                    <label class="export-field">
                        <span>Tail</span>
                        <select v-model.number="tail" class="select" v-tooltip.bottom="{ value: 'Silence after the last step, so reverbs and delays can ring out', showDelay: 400 }">
                            <option v-for="value in TAILS" :key="value" :value="value">{{ value }} s</option>
                        </select>
                    </label>
                </div>
            </fieldset>

            <p class="export-outlook" :data-error="'error' in outlook" aria-live="polite">
                <template v-if="progress">
                    <Icon icon="mdi:record-circle" class="w-4 h-4 export-recording" />
                    <span class="export-progress-text">Recording {{ seconds(progress.elapsed) }} of {{ seconds(progress.total) }}, you hear it as it plays.</span>
                    <span class="export-progress" :style="{ '--export-progress': `${(progress.elapsed / Math.max(progress.total, 0.001)) * 100}%` }" />
                </template>
                <template v-else-if="isExporting"><Icon icon="mdi:loading" class="w-4 h-4 animate-spin" /> {{ method === 'live' ? 'Preparing…' : 'Rendering… this is faster than playing it.' }}</template>
                <template v-else-if="'seconds' in outlook"><Icon icon="mdi:clock-outline" class="w-4 h-4" /> About {{ seconds(outlook.seconds) }} of stereo audio.</template>
                <template v-else><Icon icon="mdi:alert-circle-outline" class="w-4 h-4" /> {{ outlook.error }}</template>
            </p>

            <div class="export-actions">
                <Button v-if="progress" type="button" label="Cancel" text size="small" @click="cancelExport" />
                <Button v-else type="button" label="Cancel" text size="small" :disabled="isExporting" @click="closeDialog" />
                <Button
                    type="submit"
                    :label="isExporting ? (progress ? 'Recording…' : method === 'live' ? 'Preparing…' : 'Rendering…') : `Export ${format.toUpperCase()}`"
                    size="small"
                    :disabled="!canExport"
                    :loading="isExporting"
                />
            </div>
        </form>
    </Dialog>
</template>
