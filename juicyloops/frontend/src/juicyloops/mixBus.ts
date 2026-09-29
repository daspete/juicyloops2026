import { Gain, getDestination, PanVol, type ToneAudioNode } from 'tone';
import { markRaw, shallowRef } from 'vue';
import { createParameterTable, MIX_PARAMS, type Automatable, type AutomationParam, type ParameterTable } from './automation';
import { PARAM_RAMP_TIME } from './constants';
import { Effects, type EffectsSnapshot, type LegacyEffectsSnapshot } from './effects/effects';
import { SEND_PARAMS, sendIndexOf, Sends } from './sends';

export interface BusSnapshot {
    volume: number;
    pan: number;
    effects: EffectsSnapshot | LegacyEffectsSnapshot;
    /** Missing in states from before the mixer rack. */
    isMuted?: boolean;
    isSolo?: boolean;
    sends?: number[];
}

/** What a bus is: a container's channel (it has sends), a return, or the master. */
export type BusRole = 'bus' | 'return' | 'master';

const BUS_PARAMETERS = createParameterTable([...MIX_PARAMS, ...SEND_PARAMS]);
const PLAIN_PARAMETERS = createParameterTable(MIX_PARAMS);

/**
 * A summing stage with its own effect rack, volume/pan and mute: `input -> effects -> panvol -> mute -> out`.
 *
 * Every track container has one (all its tracks feed into it), the session has two returns (what the sends feed) and
 * the master (everything feeds it). The class is plain audio, the UI shows it through the mixer strips.
 *
 * Mute is the user's switch; `silenced` is set from outside by the session's solo state. Either one closes the gate.
 * Sends (container buses only) and meters tap after the gate, so a muted channel sends and shows nothing.
 */
export class MixBus implements Automatable {
    /** Where the sources connect to. */
    readonly input: ToneAudioNode = new Gain();

    readonly effects: Effects;

    readonly role: BusRole;

    /** Volume (dB) and pan (-1..1) stage after the effects. */
    private readonly panVol = new PanVol(0, 0);

    /** Mute and solo close this gate. The bus's output. */
    private readonly gate = new Gain(1);

    /** The sends to the returns; only a container's channel has them. */
    readonly sends: Sends | null;

    /** Level and pan as stored, reactive so every strip and knob showing them follows (the bus itself is raw). */
    private readonly level = shallowRef(0);
    private readonly panning = shallowRef(0);

    get volume(): number {
        return this.level.value;
    }

    set volume(value: number) {
        this.level.value = value;
    }

    get pan(): number {
        return this.panning.value;
    }

    set pan(value: number) {
        this.panning.value = value;
    }

    /** Reactive mirrors of mute and solo, so every strip showing this bus updates (the bus itself is raw). */
    private readonly muted = shallowRef(false);
    private readonly soloed = shallowRef(false);
    private isSilenced = false;

    /** Where `connectTo` sends the bus; kept so a sleeping bus can find its way back. */
    private destination: ToneAudioNode | null = null;
    private isAsleep = false;

    private readonly table: ParameterTable;

    /** `master` for the song's master channel (its rack starts with the limiter on), `bus` for a container's, `return` for A/B. */
    constructor(role: BusRole = 'bus') {
        this.role = role;
        this.effects = markRaw(new Effects({ role: role === 'master' ? 'master' : 'bus' }));
        this.effects.connect(this.input, this.panVol);
        this.panVol.connect(this.gate);
        this.sends = role === 'bus' ? markRaw(new Sends(this.gate)) : null;
        this.table = role === 'bus' ? BUS_PARAMETERS : PLAIN_PARAMETERS;
    }

    /** The node meters read: after the fader and the mute gate. Connect to it, never disconnect it. */
    get meterSource(): ToneAudioNode {
        return this.gate;
    }

    get isMuted(): boolean {
        return this.muted.value;
    }

    get isSolo(): boolean {
        return this.soloed.value;
    }

    setMuted(muted: boolean): void {
        this.muted.value = muted;
        this.updateGate();
    }

    setSolo(solo: boolean): void {
        this.soloed.value = solo;
    }

    /** Silenced by someone else's solo. */
    setSilenced(silenced: boolean): void {
        if (this.isSilenced !== silenced) {
            this.isSilenced = silenced;
            this.updateGate();
        }
    }

    /** Whether the bus can be heard at all (not muted, not silenced by a solo). */
    get isOpen(): boolean {
        return !this.muted.value && !this.isSilenced;
    }

    /** Sends this bus into another node, replacing where it went before. */
    connectTo(destination: ToneAudioNode): void {
        if (this.destination && !this.isAsleep) {
            this.gate.disconnect(this.destination);
        }
        this.destination = destination;
        if (!this.isAsleep) {
            this.gate.connect(destination);
        }
    }

    /**
     * Takes the bus out of the mix and throws its effect nodes away (the values stay), for a container that has
     * nothing to play (see `hibernate.ts`). Only once nothing it carries can still be heard: the sound stops dead.
     */
    sleep(): void {
        if (this.isAsleep) {
            return;
        }
        this.isAsleep = true;
        if (this.destination) {
            this.gate.disconnect(this.destination);
        }
        this.effects.suspend();
    }

    /** Rebuilds the effects and goes back into the mix. */
    wake(): void {
        if (!this.isAsleep) {
            return;
        }
        this.isAsleep = false;
        this.effects.resume();
        if (this.destination) {
            this.gate.connect(this.destination);
        }
    }

    /** Sends this bus straight to the speakers. */
    toDestination(): void {
        this.connectTo(getDestination());
    }

    /** With a `time` the level is only played, not stored (automation); see `settle`. */
    setVolume(volume: number, time?: number): void {
        this.panVol.volume.rampTo(volume, PARAM_RAMP_TIME, time);
        if (time === undefined) {
            this.volume = volume;
        }
    }

    setPan(pan: number, time?: number): void {
        this.panVol.pan.rampTo(pan, PARAM_RAMP_TIME, time);
        if (time === undefined) {
            this.pan = pan;
        }
    }

    /** Puts the stored value of a parameter back on the sound, after automation moved it. */
    settle(key: string): void {
        this.setParameter(key, this.getParameter(key));
    }

    capture(): BusSnapshot {
        return {
            volume: this.volume,
            pan: this.pan,
            effects: this.effects.capture(),
            isMuted: this.isMuted,
            isSolo: this.isSolo,
            ...(this.sends ? { sends: [...this.sends.levels] } : {}),
        };
    }

    restore(snapshot: BusSnapshot): void {
        this.setVolume(snapshot.volume);
        this.setPan(snapshot.pan);
        this.setMuted(snapshot.isMuted ?? false);
        this.setSolo(snapshot.isSolo ?? false);
        this.sends?.restore(snapshot.sends);
        this.effects.restore(snapshot.effects);
    }

    get parameters(): readonly AutomationParam[] {
        return [...this.table.list, ...this.effects.parameters];
    }

    parameter(key: string): AutomationParam | undefined {
        return this.table.byKey.get(key) ?? this.effects.parameter(key);
    }

    getParameter(key: string): number {
        if (key === 'volume') {
            return this.volume;
        }
        if (key === 'pan') {
            return this.pan;
        }
        const send = sendIndexOf(key);
        if (send >= 0) {
            return this.sends?.levels[send] ?? 0;
        }
        return this.effects.getParameter(key);
    }

    setParameter(key: string, value: number, time?: number): void {
        if (key === 'volume') {
            this.setVolume(value, time);
        } else if (key === 'pan') {
            this.setPan(value, time);
        } else if (sendIndexOf(key) >= 0) {
            this.sends?.setLevel(sendIndexOf(key), value, time);
        } else {
            this.effects.setParameter(key, value, time);
        }
    }

    /** Copies the effect rack, the level settings and the sends of another bus. */
    copyFrom(source: MixBus): void {
        this.effects.copyFrom(source.effects);
        this.setVolume(source.volume);
        this.setPan(source.pan);
        if (this.sends && source.sends) {
            this.sends.restore(source.sends.levels);
        }
    }

    dispose(): void {
        this.sends?.dispose();
        this.effects.dispose();
        this.input.dispose();
        this.panVol.dispose();
        this.gate.dispose();
    }

    private updateGate(): void {
        this.gate.gain.rampTo(this.isOpen ? 1 : 0, PARAM_RAMP_TIME);
    }
}
