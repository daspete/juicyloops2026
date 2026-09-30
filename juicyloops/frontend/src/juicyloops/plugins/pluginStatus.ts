import { reactive } from 'vue';

/**
 * Loading state of every plugin the studio runs, by owner (a synth track's id, or `<rack owner>:<slot id>` for an
 * effect). Kept out of the tracks and racks on purpose: they are raw or reactive depending on who calls them, and
 * a plugin finishes loading whenever it likes; this map is always reactive.
 */
export type PluginStatus = { state: 'loading' } | { state: 'ready'; name: string; vendor: string } | { state: 'error'; message: string };

const statuses = reactive(new Map<string, PluginStatus>());

export const pluginStatus = (owner: string): PluginStatus | undefined => statuses.get(owner);

export const setPluginStatus = (owner: string, status: PluginStatus | null): void => {
    if (status) {
        statuses.set(owner, status);
    } else {
        statuses.delete(owner);
    }
};

/** The words for a load that failed. */
export const pluginErrorMessage = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/Failed to fetch|NetworkError|dynamically imported module|Importing a module script failed/i.test(message)) {
        return 'The plugin could not be downloaded. Check the address and your connection.';
    }
    return message || 'The plugin could not start.';
};
