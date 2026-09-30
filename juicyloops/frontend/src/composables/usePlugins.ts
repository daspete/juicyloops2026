import type { WamNode, WebAudioModule } from '@webaudiomodules/api';
import { ref, shallowRef } from 'vue';
import type { PluginKind } from '@/juicyloops/plugins/catalog';
import type { PluginRef } from '@/juicyloops/plugins/pluginRef';

/**
 * The plugin browser (one dialog for the whole studio) and the open plugin windows. Module level, so a device card
 * that re-mounts (after an undo, a preset) does not close the window of its plugin.
 */

interface BrowserRequest {
    kind: PluginKind;
    /** What happens with the plugin picked. */
    pick: (plugin: PluginRef) => void;
}

export interface PluginWindowEntry {
    /** One window per plugin: its owner key in `pluginStatus`. */
    key: string;
    title: string;
    /** The loaded plugin, or null while it loads. */
    module: () => WebAudioModule<WamNode> | null;
    /** Reads the plugin's state back into the session; called now and then while the window is open, and on close. */
    refresh?: () => void;
}

const browser = shallowRef<BrowserRequest | null>(null);
const windows = ref<PluginWindowEntry[]>([]);

const openBrowser = (kind: PluginKind, pick: (plugin: PluginRef) => void): void => {
    browser.value = { kind, pick };
};

const closeBrowser = (): void => {
    browser.value = null;
};

/** Opens a plugin's window, or brings it to the front when it is open already. */
const openWindow = (entry: PluginWindowEntry): void => {
    windows.value = [...windows.value.filter((open) => open.key !== entry.key), entry];
};

const closeWindow = (key: string): void => {
    const entry = windows.value.find((open) => open.key === key);
    entry?.refresh?.();
    windows.value = windows.value.filter((open) => open.key !== key);
};

export const usePlugins = () => ({ browser, openBrowser, closeBrowser, windows, openWindow, closeWindow });
