import type { ToneAudioNode } from 'tone';
import { computed } from 'vue';
import { targetKey, type AutomationTarget } from '@/juicyloops/automation';
import type { Effects } from '@/juicyloops/effects/effects';
import type { MixBus } from '@/juicyloops/mixBus';
import { RETURN_NAMES } from '@/juicyloops/sends';
import type { TrackContainer } from '@/juicyloops/trackContainer';
import type { BaseTrack } from '@/juicyloops/tracks/BaseTrack';
import { TRACK_META } from '@/components/tracks/trackMeta';
import { useJuicyLoops } from './useJuicyLoops';

/**
 * Every channel of the session as one shape, whatever it is: a track, a container channel, a return or the master.
 * The mixer strips, the device rack and the Inspector all work on this, so a strip is a strip.
 *
 * A model reads through reactive sources (a track's reactive proxy, a bus's reactive level refs), so a computed built
 * on it re-renders when a value changes anywhere: the head slider of a track and its mixer fader stay in step.
 */
export interface ChannelModel {
    readonly key: string;
    readonly target: AutomationTarget;
    readonly kind: AutomationTarget['kind'];
    /** What the strip and the Inspector call it. */
    readonly name: string;
    /** A short word for the kind: `Synth`, `Container`, `Return`, `Master`. */
    readonly role: string;
    readonly icon: string;
    /** A CSS colour. */
    readonly accent: string;
    readonly effects: Effects;
    /** Where meters tap in (after the fader). */
    readonly meterSource: ToneAudioNode;
    readonly volume: number;
    readonly pan: number;
    setVolume(value: number): void;
    setPan(value: number): void;
    readonly isMuted: boolean;
    readonly isSolo: boolean;
    /** False for the master: it has no solo. */
    readonly canSolo: boolean;
    toggleMute(): void;
    toggleSolo(): void;
    /** Send levels (dB) to the returns, or null for a channel without sends. */
    readonly sends: readonly number[] | null;
    setSend(index: number, level: number): void;
    /** The track (reactive proxy) of a track channel. */
    readonly track?: BaseTrack;
    /** The container (reactive proxy) of a track or container channel. */
    readonly container?: TrackContainer;
    /** The bus of a container channel, a return or the master. */
    readonly bus?: MixBus;
}

/** A track's name as the UI shows it: what the user called it, or its type and number. */
export const trackName = (track: BaseTrack, index: number): string => track.name.trim() || `${TRACK_META[track.type].label} ${index + 1}`;

const { engine, containers } = useJuicyLoops();

const busModel = (bus: MixBus, target: AutomationTarget, name: string, role: string, icon: string, accent: string, container?: TrackContainer): ChannelModel => ({
    key: targetKey(target),
    target,
    kind: target.kind,
    get name() {
        return container ? container.name : name;
    },
    role,
    icon,
    accent,
    effects: bus.effects,
    meterSource: bus.meterSource,
    get volume() {
        return bus.volume;
    },
    get pan() {
        return bus.pan;
    },
    setVolume: (value) => bus.setVolume(value),
    setPan: (value) => bus.setPan(value),
    get isMuted() {
        return bus.isMuted;
    },
    get isSolo() {
        return bus.isSolo;
    },
    canSolo: target.kind !== 'master',
    toggleMute: () => bus.setMuted(!bus.isMuted),
    toggleSolo: () => bus.setSolo(!bus.isSolo),
    get sends() {
        return bus.sends ? bus.sends.levels : null;
    },
    setSend: (index, level) => {
        bus.sends?.setLevel(index, level);
        engine.sequencer.updateReturns();
    },
    container,
    bus,
});

const trackModel = (track: BaseTrack, index: number, container: TrackContainer): ChannelModel => {
    const meta = TRACK_META[track.type];
    return {
        key: targetKey({ kind: 'track', containerId: container.id, trackId: track.id }),
        target: { kind: 'track', containerId: container.id, trackId: track.id },
        kind: 'track',
        get name() {
            return trackName(track, index);
        },
        role: meta.label,
        icon: meta.icon,
        accent: meta.accent,
        effects: track.effects,
        meterSource: track.meterSource,
        get volume() {
            return track.volume;
        },
        get pan() {
            return track.pan;
        },
        setVolume: (value) => track.setVolume(value),
        setPan: (value) => track.setPan(value),
        get isMuted() {
            return track.isMuted;
        },
        get isSolo() {
            return track.isSolo;
        },
        canSolo: true,
        toggleMute: () => track.toggleMute(),
        toggleSolo: () => track.toggleSolo(),
        get sends() {
            return track.sends.levels;
        },
        setSend: (index, level) => {
            track.sends.setLevel(index, level);
            engine.sequencer.updateReturns();
        },
        track,
        container,
    };
};

export const masterChannel = (): ChannelModel => busModel(engine.master, { kind: 'master' }, 'Master', 'Master', 'mdi:speaker', 'var(--jl-brand-2)');

export const returnChannel = (index: number): ChannelModel =>
    busModel(engine.sequencer.returns[index]!, { kind: 'return', index }, `Return ${RETURN_NAMES[index]}`, 'Return', index === 0 ? 'mdi:weather-windy' : 'mdi:repeat', 'var(--jl-brand)');

export const containerChannel = (container: TrackContainer): ChannelModel =>
    busModel(container.bus, { kind: 'container', containerId: container.id }, container.name, 'Container', 'mdi:view-grid-outline', 'var(--jl-brand)', container);

export const trackChannels = (container: TrackContainer): ChannelModel[] => container.tracks.map((track, index) => trackModel(track, index, container));

/** The model of any channel, or null when it is gone (a deleted track or container). */
export const channelOf = (target: AutomationTarget): ChannelModel | null => {
    switch (target.kind) {
        case 'master':
            return masterChannel();
        case 'return':
            return engine.sequencer.returns[target.index] ? returnChannel(target.index) : null;
        default: {
            const container = containers.value.find((candidate) => candidate.id === target.containerId);
            if (!container) {
                return null;
            }
            if (target.kind === 'container') {
                return containerChannel(container);
            }
            const index = container.tracks.findIndex((track) => track.id === target.trackId);
            return index === -1 ? null : trackModel(container.tracks[index]!, index, container);
        }
    }
};

export const useChannels = () => ({
    returns: computed(() => engine.sequencer.returns.map((_, index) => returnChannel(index))),
    master: masterChannel(),
    channelOf,
    trackChannels,
    containerChannel,
});
