<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { Button } from 'primevue';
import { computed, onMounted, ref } from 'vue';
import { bridge } from '@/juicyloops/bridge/client';
import { bridgeUrl, DEFAULT_PORT, type BridgePluginInfo } from '@/juicyloops/bridge/protocol';
import type { PluginKind } from '@/juicyloops/plugins/catalog';
import type { PluginRef } from '@/juicyloops/plugins/pluginRef';

/**
 * The plugin browser's desktop section: VST3 and CLAP plugins installed on this computer, played through the Juicy
 * Loops Bridge app. Shows whether the bridge runs, pairs the studio with it (the token it shows), and lists its
 * plugins of the kind asked for.
 */
const props = defineProps<{
    kind: PluginKind;
    query: string;
}>();

const emit = defineEmits<{
    pick: [plugin: PluginRef];
}>();

const BRIDGE_DOWNLOAD_URL = 'https://github.com/daspete/juicyloops2026/releases';

const { state, message, info, plugins, scanning, token, port } = bridge;

const tokenInput = ref(token.value);
const portInput = ref(String(port.value));
const pairing = ref(false);

onMounted(() => {
    // Only reach out on its own when it was paired before: a failed attempt shows in the browser's console.
    if (token.value && (state.value === 'idle' || state.value === 'offline')) {
        bridge.connect().catch(() => undefined);
    }
});

const pair = async () => {
    pairing.value = true;
    try {
        const nextPort = Number(portInput.value);
        if (Number.isInteger(nextPort) && nextPort !== port.value) {
            bridge.setPort(nextPort);
        }
        await bridge.pair(tokenInput.value);
    } catch {
        /* the state and message say what went wrong */
    } finally {
        pairing.value = false;
    }
};

const retry = () => bridge.connect().catch(() => undefined);

const rescan = () => bridge.refreshPlugins(true).catch(() => undefined);

const forget = () => {
    tokenInput.value = '';
    void bridge.pair('').catch(() => undefined);
};

const matches = (plugin: BridgePluginInfo) => {
    const words = props.query.trim().toLowerCase();
    return !words || `${plugin.name} ${plugin.vendor} ${plugin.format} ${plugin.categories.join(' ')}`.toLowerCase().includes(words);
};

const listed = computed(() => plugins.value.filter((plugin) => plugin.kind === props.kind && matches(plugin)));

const statusText = computed(() => {
    switch (state.value) {
        case 'ready':
            return 'Connected';
        case 'connecting':
            return 'Connecting…';
        case 'unpaired':
            return 'Not paired';
        case 'offline':
            return 'Not running';
        default:
            return 'Not connected';
    }
});

const showIntro = computed(() => state.value === 'offline' || (state.value === 'idle' && !token.value));

const formatLabel = (plugin: BridgePluginInfo) => (plugin.format === 'builtin' ? 'Test' : plugin.format.toUpperCase());

const pick = (plugin: BridgePluginInfo) => {
    emit('pick', { url: bridgeUrl(plugin.id), name: plugin.name, vendor: plugin.vendor, state: null });
};
</script>

<template>
    <section class="plugin-group bridge-section" aria-label="Desktop plugins">
        <header class="bridge-head">
            <h4>Desktop plugins (VST bridge)</h4>
            <span class="bridge-pill" :data-state="state">
                <Icon v-if="state === 'connecting'" icon="mdi:loading" class="w-3 h-3 animate-spin" />
                {{ statusText }}
            </span>
            <button
                v-if="state === 'ready'"
                type="button"
                class="iconbtn"
                aria-label="Look for plugins again"
                v-tooltip.left="'Look for new plugins'"
                :disabled="scanning"
                @click="rescan"
            >
                <Icon icon="mdi:refresh" class="w-4 h-4" :class="{ 'animate-spin': scanning }" />
            </button>
        </header>

        <div v-if="showIntro" class="bridge-intro">
            <p>
                Play the VST3 and CLAP plugins installed on this computer. The free <strong>Juicy Loops Bridge</strong> app hosts them on your desktop and
                streams their sound to the studio; their own windows open there too.
            </p>
            <ol class="bridge-steps">
                <li>Download the bridge for Windows, macOS or Linux and start it.</li>
                <li>Copy the pairing token it shows and paste it below.</li>
            </ol>
            <p class="bridge-links">
                <a :href="BRIDGE_DOWNLOAD_URL" target="_blank" rel="noopener">Download the Juicy Loops Bridge</a>
                <button v-if="state === 'offline'" type="button" class="bridge-link-button" @click="retry">It runs now, try again</button>
            </p>
        </div>

        <form v-if="state !== 'ready'" class="bridge-pair" @submit.prevent="pair">
            <label class="export-label" for="bridge-token">Pairing token</label>
            <div class="plugin-address-row">
                <input
                    id="bridge-token"
                    v-model="tokenInput"
                    class="input bridge-token"
                    type="text"
                    placeholder="xxxx-xxxx-xxxx-xxxx-xxxx"
                    autocomplete="off"
                    spellcheck="false"
                    aria-describedby="bridge-token-help"
                />
                <Button type="submit" label="Connect" size="small" :loading="pairing || state === 'connecting'" :disabled="!tokenInput.trim()" />
            </div>
            <p id="bridge-token-help" class="bridge-help">
                The bridge prints it when it starts and shows it at <code>http://127.0.0.1:{{ port }}</code
                >. It is remembered in this browser.
            </p>
            <details class="bridge-advanced">
                <summary>Port</summary>
                <input
                    v-model="portInput"
                    class="input bridge-port"
                    type="number"
                    min="1"
                    max="65535"
                    :placeholder="String(DEFAULT_PORT)"
                    aria-label="Bridge port"
                />
            </details>
        </form>
        <p v-if="message && state !== 'ready'" class="plugin-error" role="status">{{ message }}</p>

        <template v-if="state === 'ready'">
            <p v-if="!listed.length" class="plugin-empty">
                <template v-if="scanning"><Icon icon="mdi:loading" class="w-4 h-4 animate-spin" /> Looking for plugins…</template>
                <template v-else-if="query.trim()">No desktop plugin matches.</template>
                <template v-else>No {{ kind === 'instrument' ? 'instrument' : 'effect' }} plugins found in this computer's VST3 and CLAP folders.</template>
            </p>
            <div v-else class="plugin-grid bridge-grid">
                <button v-for="plugin in listed" :key="plugin.id" type="button" class="plugin-pick" @click="pick(plugin)">
                    <span class="plugin-thumb bridge-thumb" :data-format="plugin.format">{{ formatLabel(plugin) }}</span>
                    <span class="plugin-text">
                        <span class="plugin-name">{{ plugin.name }}</span>
                        <span class="plugin-meta">{{ [plugin.vendor, plugin.categories.slice(0, 2).join(', ')].filter(Boolean).join(' · ') }}</span>
                    </span>
                </button>
            </div>
            <p class="bridge-help">
                Bridge {{ info?.version }} on {{ info?.os }}.
                <template v-if="info?.editors">Plugin windows open on your desktop.</template>
                <template v-else>It runs without a display, so plugins play without their windows.</template>
                Instruments add no delay to sequenced notes; effects play about 30 ms late.
                <button type="button" class="bridge-link-button" @click="forget">Unpair</button>
            </p>
        </template>
    </section>
</template>
