<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { Button, Dialog } from 'primevue';
import { computed, ref, watch } from 'vue';
import { usePlugins } from '@/composables/usePlugins';
import { addMyPlugin, communityPlugins, CURATED_PLUGINS, myPlugins, normalizePluginUrl, removeMyPlugin, type PluginEntry } from '@/juicyloops/plugins/catalog';
import type { PluginRef } from '@/juicyloops/plugins/pluginRef';
import DesktopPlugins from './DesktopPlugins.vue';
import { bridge } from '@/juicyloops/bridge/client';
import { desktopSystem, FREE_DESKTOP_PLUGINS, type FreeDesktopPlugin } from '@/juicyloops/plugins/freeDesktopPlugins';

/**
 * Picks a Web Audio Module: the community list (instruments or effects, whichever was asked for), the user's own,
 * and a field to add one by its address.
 */
const { browser, closeBrowser } = usePlugins();

const kind = computed(() => browser.value?.kind ?? 'instrument');
const isOpen = computed(() => browser.value !== null);

const community = ref<PluginEntry[]>([]);
const loadState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const loadError = ref('');
const query = ref('');

const load = async () => {
    loadState.value = 'loading';
    try {
        community.value = await communityPlugins();
        loadState.value = 'ready';
    } catch (error) {
        loadError.value = error instanceof Error ? error.message : 'The plugin list could not be loaded.';
        loadState.value = 'error';
    }
};

watch(isOpen, (open) => {
    if (open) {
        query.value = '';
        address.value = '';
        addressError.value = '';
        if (loadState.value !== 'ready') {
            void load();
        }
    }
});

const matches = (entry: { name: string; vendor: string; category: string; description: string }) => {
    const words = query.value.trim().toLowerCase();
    return !words || `${entry.name} ${entry.vendor} ${entry.category} ${entry.description}`.toLowerCase().includes(words);
};

const mine = computed(() => myPlugins.value.filter((entry) => entry.kind === kind.value && matches(entry)));
const listed = computed(() => community.value.filter((entry) => entry.kind === kind.value && matches(entry)));
const curated = computed(() => CURATED_PLUGINS.filter((entry) => entry.kind === kind.value && matches(entry)));

/* ---- tabs: plugins that run in the page, and desktop plugins through the bridge ---- */

type Tab = 'wam' | 'desktop';
const tab = ref<Tab>('wam');
const TABS: readonly { key: Tab; label: string; icon: string }[] = [
    { key: 'wam', label: 'Web Audio Modules', icon: 'mdi:web' },
    { key: 'desktop', label: 'Desktop (VST3 / CLAP)', icon: 'mdi:monitor' },
];

/** The system the free list is sorted and marked for: the bridge's, else the browser's. */
const system = computed(() => desktopSystem(bridge.info.value?.os));

/** Free desktop plugins of the kind asked for, the ones for this system first. */
const freeDesktop = computed(() => {
    const target = system.value;
    const missing = (entry: FreeDesktopPlugin) => Number(!!target && !entry.systems.includes(target));
    return FREE_DESKTOP_PLUGINS.filter((entry) => entry.kind === kind.value && matches(entry)).sort((a, b) => missing(a) - missing(b));
});

const LIVE_ONLY_HINT = 'Plays live, but is silent in exports: it takes its notes or makes its sound outside the audio engine.';

const pick = (entry: PluginEntry) => {
    browser.value?.pick({ url: entry.url, name: entry.name, vendor: entry.vendor, state: null });
    closeBrowser();
};

/** A desktop plugin (Juicy Loops Bridge). */
const pickDesktop = (plugin: PluginRef) => {
    browser.value?.pick(plugin);
    closeBrowser();
};

/* ---- by address ---- */

const address = ref('');
const addressError = ref('');

const addByAddress = () => {
    const url = normalizePluginUrl(address.value);
    if (!url) {
        addressError.value = 'That is not a web address (https://…/index.js).';
        return;
    }
    const folder = new URL(url).pathname.split('/').filter(Boolean).slice(-2, -1)[0] ?? 'Plugin';
    const entry = { url, name: decodeURIComponent(folder), vendor: new URL(url).hostname, description: '', kind: kind.value, category: 'Added by address', thumbnail: null };
    addMyPlugin(entry);
    pick({ ...entry, source: 'mine' });
};

const onVisible = (visible: boolean) => {
    if (!visible) {
        closeBrowser();
    }
};
</script>

<template>
    <Dialog
        :visible="isOpen"
        modal
        dismissable-mask
        :header="kind === 'instrument' ? 'Choose an instrument plugin' : 'Add an effect plugin'"
        class="plugin-dialog"
        :style="{ width: '44rem' }"
        :breakpoints="{ '720px': '100vw' }"
        @update:visible="onVisible"
    >
        <div class="plugin-browser">
            <div class="plugin-tabs" role="tablist" aria-label="Plugin kind">
                <button
                    v-for="item in TABS"
                    :id="`plugin-tab-${item.key}`"
                    :key="item.key"
                    type="button"
                    role="tab"
                    class="plugin-tab"
                    :aria-selected="tab === item.key"
                    :aria-controls="`plugin-panel-${item.key}`"
                    :data-active="tab === item.key"
                    @click="tab = item.key"
                >
                    <Icon :icon="item.icon" class="w-4 h-4" />
                    <span>{{ item.label }}</span>
                </button>
            </div>
            <input v-model="query" class="input" type="search" placeholder="Search plugins" aria-label="Search plugins" />

            <div v-if="tab === 'wam'" id="plugin-panel-wam" class="plugin-panel" role="tabpanel" aria-labelledby="plugin-tab-wam">
            <p class="plugin-note">
                <Icon icon="mdi:shield-alert-outline" class="w-4 h-4 shrink-0" />
                <span>Web Audio Modules are plugins that run in your browser. They load code from the site that hosts them, so only add ones you trust. Plugins marked “Live only” play live but are silent in exports.</span>
            </p>

            <section v-if="mine.length" class="plugin-group" aria-label="Your plugins">
                <h4>Yours</h4>
                <div v-for="entry in mine" :key="entry.url" class="plugin-item">
                    <button type="button" class="plugin-pick" @click="pick(entry)">
                        <span class="plugin-thumb"><Icon icon="mdi:puzzle-outline" class="w-6 h-6" /></span>
                        <span class="plugin-text">
                            <span class="plugin-name">{{ entry.name }}</span>
                            <span class="plugin-meta">{{ entry.vendor }}</span>
                        </span>
                    </button>
                    <button type="button" class="iconbtn" :aria-label="`Forget ${entry.name}`" v-tooltip.left="'Forget this plugin'" @click="removeMyPlugin(entry.url)">
                        <Icon icon="mdi:close" class="w-4 h-4" />
                    </button>
                </div>
            </section>

            <section v-if="curated.length" class="plugin-group" aria-label="More plugins">
                <h4>More from the web</h4>
                <div class="plugin-grid">
                    <button v-for="entry in curated" :key="entry.url" type="button" class="plugin-pick" @click="pick(entry)">
                        <span class="plugin-thumb"><Icon icon="mdi:puzzle-outline" class="w-6 h-6" /></span>
                        <span class="plugin-text">
                            <span class="plugin-name">
                                {{ entry.name }}
                                <span v-if="entry.liveOnly" class="plugin-badge" v-tooltip.top="LIVE_ONLY_HINT">Live only</span>
                            </span>
                            <span class="plugin-meta">{{ entry.vendor }} · {{ entry.category }}</span>
                            <span class="plugin-desc">{{ entry.description }}</span>
                        </span>
                    </button>
                </div>
            </section>

            <section class="plugin-group" aria-label="Community plugins">
                <h4>Web Audio Modules community</h4>
                <p v-if="loadState === 'loading'" class="plugin-empty"><Icon icon="mdi:loading" class="w-4 h-4 animate-spin" /> Loading the list…</p>
                <p v-else-if="loadState === 'error'" class="plugin-empty">
                    {{ loadError }}
                    <Button type="button" label="Try again" text size="small" @click="load" />
                </p>
                <p v-else-if="!listed.length" class="plugin-empty">No plugin matches.</p>
                <div v-else class="plugin-grid">
                    <button v-for="entry in listed" :key="entry.url" type="button" class="plugin-pick" @click="pick(entry)">
                        <span class="plugin-thumb">
                            <img v-if="entry.thumbnail" :src="entry.thumbnail" alt="" loading="lazy" referrerpolicy="no-referrer" />
                            <Icon v-else icon="mdi:puzzle-outline" class="w-6 h-6" />
                        </span>
                        <span class="plugin-text">
                            <span class="plugin-name">
                                {{ entry.name }}
                                <span v-if="entry.liveOnly" class="plugin-badge" v-tooltip.top="LIVE_ONLY_HINT">Live only</span>
                            </span>
                            <span class="plugin-meta">{{ entry.vendor }} · {{ entry.category }}</span>
                            <span class="plugin-desc">{{ entry.description }}</span>
                        </span>
                    </button>
                </div>
            </section>

            <form class="plugin-address" @submit.prevent="addByAddress">
                <label class="export-label" for="plugin-address">Add by address</label>
                <div class="plugin-address-row">
                    <input id="plugin-address" v-model="address" class="input" type="url" placeholder="https://example.com/my-plugin/index.js" @input="addressError = ''" />
                    <Button type="submit" label="Add" size="small" :disabled="!address.trim()" />
                </div>
                <p v-if="addressError" class="plugin-error">{{ addressError }}</p>
            </form>
            </div>

            <div v-else id="plugin-panel-desktop" class="plugin-panel" role="tabpanel" aria-labelledby="plugin-tab-desktop">
                <DesktopPlugins :kind="kind" :query="query" @pick="pickDesktop" />

                <section class="plugin-group" aria-label="Free desktop plugins">
                    <h4>Free {{ kind === 'instrument' ? 'instruments' : 'effects' }} to download</h4>
                    <p class="bridge-help">
                        Install one, then press ↻ in Desktop plugins above. These open the maker’s page in a new tab.
                        <template v-if="system">Sorted for {{ system }}.</template>
                    </p>
                    <p v-if="!freeDesktop.length" class="plugin-empty">No plugin matches.</p>
                    <div v-else class="plugin-grid">
                        <a
                            v-for="entry in freeDesktop"
                            :key="entry.url + entry.name"
                            class="plugin-pick plugin-free"
                            :href="entry.url"
                            target="_blank"
                            rel="noopener"
                            :data-unavailable="!!system && !entry.systems.includes(system)"
                        >
                            <span class="plugin-thumb"><Icon :icon="entry.kind === 'instrument' ? 'mdi:piano' : 'mdi:tune-vertical-variant'" class="w-6 h-6" /></span>
                            <span class="plugin-text">
                                <span class="plugin-name">
                                    {{ entry.name }}
                                    <Icon icon="mdi:open-in-new" class="w-3 h-3 inline-block align-baseline opacity-60" />
                                </span>
                                <span class="plugin-meta">{{ entry.vendor }} · {{ entry.category }}</span>
                                <span class="plugin-desc">{{ entry.description }}</span>
                                <span class="plugin-chips">
                                    <span v-for="format in entry.formats" :key="format" class="plugin-chip">{{ format }}</span>
                                    <span class="plugin-chip plugin-chip--systems">{{ entry.systems.join(' · ') }}</span>
                                    <span v-if="system && !entry.systems.includes(system)" class="plugin-badge">Not for {{ system }}</span>
                                    <span v-if="entry.note" class="plugin-chip plugin-chip--note">{{ entry.note }}</span>
                                </span>
                            </span>
                        </a>
                    </div>
                </section>
            </div>
        </div>
    </Dialog>
</template>
