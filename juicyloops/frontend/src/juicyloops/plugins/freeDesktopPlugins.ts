import type { PluginKind } from './catalog';

/**
 * Free desktop plugins that play through the VST bridge, for the plugin browser's "Desktop" tab: a reading list with
 * download links, not something the studio installs. The bridge hosts VST3 and CLAP only, so every entry has one of
 * those. Formats and systems were checked against the makers' pages and release files on 2026-10-01; CLAP is listed
 * only where the maker says so.
 */
export type DesktopSystem = 'Windows' | 'macOS' | 'Linux';

export interface FreeDesktopPlugin {
    name: string;
    vendor: string;
    kind: PluginKind;
    category: string;
    description: string;
    formats: readonly ('VST3' | 'CLAP')[];
    systems: readonly DesktopSystem[];
    /** The maker's download page. */
    url: string;
    /** What it takes to get it, when more than a download (an account, the maker's installer). */
    note?: string;
}

const ALL: readonly DesktopSystem[] = ['Windows', 'macOS', 'Linux'];
const WIN_MAC: readonly DesktopSystem[] = ['Windows', 'macOS'];

export const FREE_DESKTOP_PLUGINS: readonly FreeDesktopPlugin[] = [
    /* ---- instruments ---- */
    {
        name: 'Surge XT',
        vendor: 'Surge Synth Team',
        kind: 'instrument',
        category: 'Synthesizer',
        description: 'A deep hybrid synth: subtractive, wavetable and FM oscillators, two filters, many effects and thousands of presets.',
        formats: ['VST3', 'CLAP'],
        systems: ALL,
        url: 'https://surge-synthesizer.github.io/',
    },
    {
        name: 'Vital',
        vendor: 'Matt Tytel',
        kind: 'instrument',
        category: 'Wavetable synth',
        description: 'A spectral wavetable synth with drag-and-drop modulation; the free version has plenty of presets.',
        formats: ['VST3'],
        systems: ALL,
        url: 'https://vital.audio/',
        note: 'Free account',
    },
    {
        name: 'Odin 2',
        vendor: 'TheWaveWarden',
        kind: 'instrument',
        category: 'Synthesizer',
        description: 'A 24-voice analog-style synth with three oscillators, two filters and a mod matrix.',
        formats: ['VST3', 'CLAP'],
        systems: ALL,
        url: 'https://thewavewarden.com/odin2',
    },
    {
        name: 'Dexed',
        vendor: 'Digital Suburban',
        kind: 'instrument',
        category: 'FM synth',
        description: 'A model of the Yamaha DX7 that loads original DX7 sound banks.',
        formats: ['VST3'],
        systems: ALL,
        url: 'https://asb2m10.github.io/dexed/',
    },
    {
        name: 'Tyrell N6',
        vendor: 'u-he',
        kind: 'instrument',
        category: 'Synthesizer',
        description: 'A warm Juno-style analog synth from the makers of Diva.',
        formats: ['VST3', 'CLAP'],
        systems: ALL,
        url: 'https://u-he.com/products/tyrelln6/',
    },
    {
        name: 'Decent Sampler',
        vendor: 'Decent Samples',
        kind: 'instrument',
        category: 'Sampler',
        description: 'Plays sample libraries in its open format; many free libraries (pianos, strings, drums) are made for it.',
        formats: ['VST3'],
        systems: ALL,
        url: 'https://www.decentsamples.com/product/decent-sampler-plugin/',
    },
    {
        name: 'LABS',
        vendor: 'Spitfire Audio',
        kind: 'instrument',
        category: 'Sampled instruments',
        description: 'A growing set of free sampled instruments: soft pianos, strings, choirs, textures.',
        formats: ['VST3'],
        systems: WIN_MAC,
        url: 'https://labs.spitfireaudio.com/',
        note: 'Free account and the LABS app',
    },
    {
        name: 'Cardinal',
        vendor: 'DISTRHO',
        kind: 'instrument',
        category: 'Modular',
        description: 'The VCV Rack modular system as a plugin, with over a thousand modules built in.',
        formats: ['VST3', 'CLAP'],
        systems: ALL,
        url: 'https://cardinal.kx.studio/',
    },

    /* ---- effects ---- */
    {
        name: 'Valhalla Supermassive',
        vendor: 'Valhalla DSP',
        kind: 'effect',
        category: 'Reverb & delay',
        description: 'Huge reverbs and echoes, from lush halls to endless shimmering spaces.',
        formats: ['VST3'],
        systems: WIN_MAC,
        url: 'https://valhalladsp.com/shop/reverb/valhalla-supermassive/',
    },
    {
        name: 'Dragonfly Reverb',
        vendor: 'Michael Willis',
        kind: 'effect',
        category: 'Reverb',
        description: 'Four natural-sounding reverbs: hall, room, plate and early reflections.',
        formats: ['VST3'],
        systems: ALL,
        url: 'https://michaelwillis.github.io/dragonfly-reverb/',
    },
    {
        name: 'TDR Nova',
        vendor: 'Tokyo Dawn Labs',
        kind: 'effect',
        category: 'Dynamic EQ',
        description: 'A parallel dynamic equalizer: an EQ whose bands can also compress.',
        formats: ['VST3'],
        systems: WIN_MAC,
        url: 'https://www.tokyodawn.net/tdr-nova/',
    },
    {
        name: 'TDR Kotelnikov',
        vendor: 'Tokyo Dawn Labs',
        kind: 'effect',
        category: 'Compressor',
        description: 'A clean, transparent mastering compressor.',
        formats: ['VST3'],
        systems: WIN_MAC,
        url: 'https://www.tokyodawn.net/tdr-kotelnikov/',
    },
    {
        name: 'OTT',
        vendor: 'Xfer Records',
        kind: 'effect',
        category: 'Multiband compressor',
        description: 'The famous over-the-top three-band upward and downward compressor.',
        formats: ['VST3'],
        systems: WIN_MAC,
        url: 'https://xferrecords.com/freeware',
    },
    {
        name: 'CHOW Tape Model',
        vendor: 'chowdsp',
        kind: 'effect',
        category: 'Tape',
        description: 'A physical model of a reel-to-reel tape machine: saturation, wow, flutter and loss.',
        formats: ['VST3', 'CLAP'],
        systems: ALL,
        url: 'https://chowdsp.com/products.html',
    },
    {
        name: 'Airwindows Consolidated',
        vendor: 'Airwindows',
        kind: 'effect',
        category: 'Effects collection',
        description: 'Hundreds of Airwindows effects (saturation, consoles, reverbs, dither) in one plugin.',
        formats: ['VST3', 'CLAP'],
        systems: ALL,
        url: 'https://www.airwindows.com/consolidated/',
    },
    {
        name: 'Kilohearts Essentials',
        vendor: 'Kilohearts',
        kind: 'effect',
        category: 'Effects collection',
        description: 'Over 30 small, clean effects: chorus, delay, distortion, filters, compressor and more.',
        formats: ['VST3'],
        systems: WIN_MAC,
        url: 'https://kilohearts.com/products/kilohearts_essentials',
        note: 'Free account and the Kilohearts installer',
    },
    {
        name: 'MFreeFXBundle',
        vendor: 'MeldaProduction',
        kind: 'effect',
        category: 'Effects collection',
        description: 'Around 40 free mixing and mastering tools: EQ, compressor, analyzers, modulation.',
        formats: ['VST3'],
        systems: WIN_MAC,
        url: 'https://www.meldaproduction.com/MFreeFxBundle',
        note: 'MeldaProduction installer',
    },
];

/** The system the bridge runs on (Rust's `std::env::consts::OS`), or a guess from the browser when it is not connected. */
export const desktopSystem = (bridgeOs: string | undefined, userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): DesktopSystem | null => {
    const source = (bridgeOs ?? userAgent).toLowerCase();
    // macOS first: "darwin" contains "win".
    if (/mac|darwin/.test(source)) {
        return 'macOS';
    }
    if (/win/.test(source)) {
        return 'Windows';
    }
    if (/linux|x11/.test(source) && !/android/.test(source)) {
        return 'Linux';
    }
    return null;
};
