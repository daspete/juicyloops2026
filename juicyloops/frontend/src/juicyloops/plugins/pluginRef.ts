/** A plugin as tracks and racks store it: where it loads from, what it is called, and its settings. */
export interface PluginRef {
    /** The URL of the plugin's `index.js` (an ES module whose default export is the WAM class). */
    url: string;
    name: string;
    vendor?: string;
    /** The plugin's own state (`getState`), JSON-safe; null before it was first read. */
    state?: unknown;
}

export const isPluginRef = (value: unknown): value is PluginRef =>
    !!value && typeof value === 'object' && typeof (value as PluginRef).url === 'string' && typeof (value as PluginRef).name === 'string';

export const copyPluginRef = (ref: PluginRef): PluginRef => ({ url: ref.url, name: ref.name, vendor: ref.vendor, state: ref.state === undefined ? null : JSON.parse(JSON.stringify(ref.state)) });
