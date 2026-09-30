import { ref } from 'vue';

/**
 * Where plugins come from: the Web Audio Modules community list (plugins hosted by webaudiomodules.com, served with
 * CORS so any page may load them), and addresses the user added themselves (kept in this browser).
 */
export type PluginKind = 'instrument' | 'effect';

export interface PluginEntry {
    /** The URL of the plugin's `index.js`; also its identity here. */
    url: string;
    name: string;
    vendor: string;
    description: string;
    kind: PluginKind;
    /** Finer category (`Reverb`, `Synthesizer`, ...). */
    category: string;
    thumbnail: string | null;
    source: 'community' | 'mine';
}

export const COMMUNITY_URL = 'https://www.webaudiomodules.com/community/plugins.json';
const COMMUNITY_BASE = 'https://www.webaudiomodules.com/community/plugins/';

interface CommunityRecord {
    identifier?: string;
    name?: string;
    vendor?: string;
    description?: string;
    category?: string[];
    thumbnail?: string;
    path?: string;
}

/**
 * Community entries that cannot work here: they need a microphone, a MIDI device, video, or play files of their own
 * rather than notes.
 */
const UNSUITABLE = new Set(['com.sequencerParty.audioInput', 'com.sequencerParty.audioTrack']);

/** An entry of the community list as a plugin, or null when it is neither an instrument nor an audio effect. */
export const fromCommunity = (record: CommunityRecord): PluginEntry | null => {
    const [group, category = ''] = record.category ?? [];
    const kind: PluginKind | null = group === 'Instrument' ? 'instrument' : group === 'Effect' ? 'effect' : null;
    if (!kind || !record.path || !record.name || UNSUITABLE.has(record.identifier ?? '') || category === 'Audio Player') {
        return null;
    }
    return {
        url: new URL(record.path, COMMUNITY_BASE).href,
        name: record.name,
        vendor: record.vendor ?? '',
        description: record.description ?? '',
        kind,
        category,
        thumbnail: record.thumbnail ? new URL(record.thumbnail, COMMUNITY_BASE).href : null,
        source: 'community',
    };
};

let community: Promise<PluginEntry[]> | null = null;

/** The community list, fetched once per page (again after a failure). */
export const communityPlugins = (): Promise<PluginEntry[]> => {
    community ??= fetch(COMMUNITY_URL)
        .then((response) => {
            if (!response.ok) {
                throw new Error(`The plugin list could not be loaded (${response.status}).`);
            }
            return response.json() as Promise<CommunityRecord[]>;
        })
        .then((records) => records.map(fromCommunity).filter((entry): entry is PluginEntry => !!entry));
    community.catch(() => (community = null));
    return community;
};

const STORAGE_KEY = 'juicyloops:plugins';

const readMine = (): PluginEntry[] => {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as PluginEntry[];
        return Array.isArray(stored) ? stored.filter((entry) => typeof entry?.url === 'string' && typeof entry?.name === 'string') : [];
    } catch {
        return [];
    }
};

/** Plugins the user added by address. */
export const myPlugins = ref<PluginEntry[]>(typeof localStorage === 'undefined' ? [] : readMine());

const writeMine = () => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(myPlugins.value));
    } catch {
        /* not remembered */
    }
};

/** A plugin address as typed: a folder gets its `index.js`; only http(s). Null when it is no address at all. */
export const normalizePluginUrl = (input: string): string | null => {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return null;
    }
    if (!/\.m?js$/.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(/\/$/, '')}/index.js`;
    }
    return url.href;
};

export const addMyPlugin = (entry: Omit<PluginEntry, 'source'>): void => {
    myPlugins.value = [...myPlugins.value.filter((mine) => mine.url !== entry.url), { ...entry, source: 'mine' }];
    writeMine();
};

export const removeMyPlugin = (url: string): void => {
    myPlugins.value = myPlugins.value.filter((mine) => mine.url !== url);
    writeMine();
};
