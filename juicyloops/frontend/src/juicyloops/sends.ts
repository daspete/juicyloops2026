import { dbToGain, Gain, type ToneAudioNode } from 'tone';
import { shallowRef, toRaw } from 'vue';
import type { AutomationParam } from './automation';
import { PARAM_RAMP_TIME } from './constants';

/** How many return buses a session has (A and B). */
export const RETURN_COUNT = 2;

/** A send at this level (dB) or below is off: no node, no signal. */
export const SEND_OFF = -40;
export const SEND_MAX = 6;

export const RETURN_NAMES: readonly string[] = ['A', 'B'];

const formatSend = (value: number) => (value <= SEND_OFF ? 'Off' : `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`);

/** `send.0`, `send.1`: how much of a channel goes to return A and B, automatable like its level. */
export const sendParamKey = (index: number): string => `send.${index}`;

export const SEND_PARAMS: readonly AutomationParam[] = RETURN_NAMES.map((name, index) => ({
    key: sendParamKey(index),
    label: `Send ${name}`,
    group: 'Mix',
    min: SEND_OFF,
    max: SEND_MAX,
    step: 0.1,
    format: formatSend,
}));

/** The return index of a send key, or -1. */
export const sendIndexOf = (key: string): number => (key.startsWith('send.') ? Number(key.slice(5)) : -1);

/**
 * The sends of one channel: a tap after its fader into each return bus. A send's gain node only exists while it is
 * above `SEND_OFF` (or automation is moving it), so a session with no sends costs nothing.
 */
export class Sends {
    /** Levels in dB, one per return. Reactive (replaced on every change), so knobs showing a send follow it. */
    private readonly stored = shallowRef<readonly number[]>(Array.from({ length: RETURN_COUNT }, () => SEND_OFF));

    get levels(): readonly number[] {
        return this.stored.value;
    }

    private readonly gains: (Gain | null)[] = Array.from({ length: RETURN_COUNT }, () => null);
    private targets: readonly ToneAudioNode[] = [];

    constructor(private readonly source: ToneAudioNode) {}

    /** Where the sends go (the return buses' inputs). Existing sends are re-wired. */
    setTargets(targets: readonly ToneAudioNode[]): void {
        this.targets = targets.map((node) => toRaw(node));
        this.gains.forEach((gain, index) => {
            if (!gain) {
                return;
            }
            gain.disconnect();
            const target = targets[index];
            if (target) {
                gain.connect(target);
            }
        });
    }

    /** With a `time` the level is only played, not stored (automation). */
    setLevel(index: number, level: number, time?: number): void {
        if (index < 0 || index >= RETURN_COUNT) {
            return;
        }
        if (time === undefined && this.stored.value[index] !== level) {
            const next = [...this.stored.value];
            next[index] = level;
            this.stored.value = next;
        }
        const on = level > SEND_OFF;
        let gain = this.gains[index];
        if (!gain) {
            if (!on) {
                return;
            }
            gain = this.gains[index] = new Gain(0);
            this.source.connect(gain);
            const target = this.targets[index];
            if (target) {
                gain.connect(target);
            }
        }
        gain.gain.rampTo(on ? dbToGain(level) : 0, PARAM_RAMP_TIME, time);
        // A send turned off by hand drops its node; one automation moves keeps it, to avoid rebuilding it every bar.
        if (!on && time === undefined) {
            this.drop(index);
        }
    }

    /** Whether any send is on. */
    get isActive(): boolean {
        return this.levels.some((level) => level > SEND_OFF);
    }

    /** Whether the send to one return is on. */
    feeds(index: number): boolean {
        return (this.levels[index] ?? SEND_OFF) > SEND_OFF;
    }

    restore(levels: readonly number[] | undefined): void {
        for (let index = 0; index < RETURN_COUNT; index++) {
            this.setLevel(index, levels?.[index] ?? SEND_OFF);
        }
    }

    dispose(): void {
        for (let index = 0; index < RETURN_COUNT; index++) {
            this.drop(index);
        }
    }

    private drop(index: number): void {
        const gain = this.gains[index];
        if (gain) {
            this.source.disconnect(gain);
            gain.dispose();
            this.gains[index] = null;
        }
    }
}
