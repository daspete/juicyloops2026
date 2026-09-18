import type { TrackType } from '@/juicyloops/tracks/registry';

/** How each track type presents itself in the UI: name, icon, one-line pitch and its juice colour. */
export const TRACK_META: Record<TrackType, { label: string; icon: string; blurb: string; accent: string }> = {
    synth: {
        label: 'Synth',
        icon: 'qlementine-icons:synthesizer-16',
        blurb: 'Tap steps to play notes. Open the piano roll to pick pitches.',
        accent: 'var(--jl-synth)',
    },
    sampler: {
        label: 'Sampler',
        icon: 'mdi:waveform',
        blurb: 'Drop in a sound file and trigger a slice of it on every step.',
        accent: 'var(--jl-sampler)',
    },
    microphone: {
        label: 'Mic',
        icon: 'mdi:microphone',
        blurb: 'Record anything with your microphone and loop it.',
        accent: 'var(--jl-mic)',
    },
};
