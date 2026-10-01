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
    source: 'community' | 'curated' | 'mine';
    /**
     * Plays live but is silent in exports: it builds its sound, or takes its notes, on the main thread, which an
     * offline render outruns. Known from testing; unknown plugins are not marked.
     */
    liveOnly?: boolean;
}

export const COMMUNITY_URL = 'https://www.webaudiomodules.com/community/plugins.json';

/** Community plugins that were tested and only play live (see `PluginEntry.liveOnly`). */
const LIVE_ONLY = new Set(['https://www.webaudiomodules.com/community/plugins/burns-audio/synth101/index.js']);

const CMAJOR = 'https://cesaref.github.io/wam/';
const WAM_TEAM = 'https://mainline.i3s.unice.fr/wam2/packages/';

const curated = (entry: Omit<PluginEntry, 'source' | 'thumbnail'>): PluginEntry => ({ ...entry, thumbnail: null, source: 'curated' });

/**
 * WAM 2 plugins hosted elsewhere (served with CORS), tested in the studio live and in an offline render on
 * 2026-10-01: the Cmajor example patches, and the WAM team's own demo host. The three Cmajor effects marked live-only
 * render with sound since `WamEffect` keeps its input reachable offline (notes/vst-bridge.md); their flags stay until
 * the tests that use them as live-only examples (`liveRender.spec.ts`) move to another plugin.
 */
export const CURATED_PLUGINS: readonly PluginEntry[] = [
    curated({ url: `${CMAJOR}Pro54/index.js`, name: 'Pro-54', vendor: 'Cmajor', category: 'Synthesizer', kind: 'instrument', liveOnly: true, description: 'Prophet-5 style analog polysynth, a port of Native Instruments’ Pro-53.' }),
    curated({ url: `${WAM_TEAM}obxd/index.js`, name: 'OB-Xd', vendor: 'Jari Kleimola', category: 'Synthesizer', kind: 'instrument', description: 'Polysynth after the Oberheim OB-X, with its own presets.' }),
    curated({ url: `${CMAJOR}TX81Z/index.js`, name: 'TX81Z', vendor: 'Cmajor', category: 'Synthesizer', kind: 'instrument', liveOnly: true, description: 'Four-operator FM synth after the Yamaha TX81Z.' }),
    curated({ url: `${CMAJOR}ElectricPiano/index.js`, name: 'Electric Piano', vendor: 'Cmajor', category: 'Keys', kind: 'instrument', liveOnly: true, description: 'A modelled electric piano.' }),
    curated({ url: `${CMAJOR}FaustFM/index.js`, name: 'Faust FM', vendor: 'GRAME · Cmajor', category: 'Synthesizer', kind: 'instrument', liveOnly: true, description: 'A small FM voice, written in Faust.' }),
    curated({ url: `${WAM_TEAM}tinySynth/src/index.js`, name: 'TinySynth', vendor: 'WAM team', category: 'General MIDI', kind: 'instrument', description: 'A General MIDI synth with 128 instruments. It has no window of its own.' }),
    curated({ url: `${CMAJOR}GuitarLSTM/index.js`, name: 'Guitar LSTM', vendor: 'Cmajor', category: 'Amp Simulator', kind: 'effect', description: 'A guitar amp modelled by a neural network.' }),
    curated({ url: `${CMAJOR}ConvolutionReverb/index.js`, name: 'Convolution Reverb', vendor: 'Cmajor', category: 'Reverb', kind: 'effect', description: 'Reverb from a recorded room.' }),
    curated({ url: `${CMAJOR}FilterEQ/index.js`, name: 'Filter EQ', vendor: 'Cmajor', category: 'Equalizer & Filter', kind: 'effect', description: 'Filters and EQ bands.' }),
    curated({ url: `${CMAJOR}Tremolo/index.js`, name: 'Tremolo', vendor: 'Cmajor', category: 'Modulation', kind: 'effect', description: 'Pulses the volume.' }),
];
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
    const url = new URL(record.path, COMMUNITY_BASE).href;
    return {
        url,
        name: record.name,
        vendor: record.vendor ?? '',
        description: record.description ?? '',
        kind,
        category,
        thumbnail: record.thumbnail ? new URL(record.thumbnail, COMMUNITY_BASE).href : null,
        source: 'community',
        ...(LIVE_ONLY.has(url) ? { liveOnly: true } : {}),
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

/**
 * Whether a plugin is known to be silent in an offline render (see `PluginEntry.liveOnly`): a tested curated or
 * community plugin, or one of the user's own that was marked so. The export dialog suggests a real-time export then.
 */
export const isLiveOnlyPlugin = (url: string): boolean =>
    LIVE_ONLY.has(url) || CURATED_PLUGINS.some((entry) => entry.url === url && entry.liveOnly) || myPlugins.value.some((entry) => entry.url === url && entry.liveOnly);
