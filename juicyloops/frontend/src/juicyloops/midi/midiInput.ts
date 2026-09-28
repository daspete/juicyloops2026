/**
 * The Web MIDI side: access, the list of inputs, hot-plugging, and which inputs are switched on.
 *
 * Access is asked for with `enable()` from a user gesture (the "Enable MIDI" button). Once it was granted, `restore()`
 * asks again by itself on the next visit, but only when the browser says it would not prompt (Permissions API), so
 * nobody gets a permission dialog out of nowhere. Every input is on unless the user switched it off; the switched-off
 * ones are remembered in localStorage (by id, and by name for browsers whose ids change between sessions).
 *
 * Framework free: `useMidi` wraps it in refs. Messages go to `onMessage` with the input's id and the event's
 * `timeStamp` (the `performance.now()` clock).
 */

export type MidiAccessState = 'unsupported' | 'off' | 'requesting' | 'on' | 'denied';

export interface MidiDevice {
    id: string;
    name: string;
    manufacturer: string;
    /** False once it was unplugged (it stays listed until the page reloads, so its switch does not jump away). */
    connected: boolean;
    enabled: boolean;
}

export interface MidiInputOptions {
    onMessage: (input: string, data: Uint8Array, timeStamp: number) => void;
    /** The state or the device list changed. */
    onChange: () => void;
    /** An input went away or was switched off: its held notes must stop. */
    onInputGone?: (input: string) => void;
}

const GRANTED_KEY = 'juicyloops:midiGranted';
const DISABLED_KEY = 'juicyloops:midiDisabled';

const storage = (): Storage | null => {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
};

const readDisabled = (): Set<string> => {
    try {
        const list = JSON.parse(storage()?.getItem(DISABLED_KEY) ?? '[]');
        return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
    } catch {
        return new Set();
    }
};

const write = (key: string, value: string): void => {
    try {
        storage()?.setItem(key, value);
    } catch {
        /* blocked storage: the choice does not persist */
    }
};

type MidiNavigator = Navigator & { requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess> };

export class MidiInput {
    state: MidiAccessState;
    readonly devices: MidiDevice[] = [];

    private access: MIDIAccess | null = null;
    private readonly disabled = readDisabled();
    private readonly listening = new Map<string, MIDIInput>();

    constructor(private readonly options: MidiInputOptions) {
        this.state = MidiInput.isSupported() ? 'off' : 'unsupported';
    }

    static isSupported(): boolean {
        return typeof navigator !== 'undefined' && typeof (navigator as MidiNavigator).requestMIDIAccess === 'function';
    }

    /** Whether access was granted on an earlier visit. */
    static wasGranted(): boolean {
        return storage()?.getItem(GRANTED_KEY) === '1';
    }

    /** Asks for MIDI access (no sysex). Call it from a user gesture. Resolves with whether access is on. */
    async enable(): Promise<boolean> {
        if (this.state === 'unsupported') {
            return false;
        }
        if (this.access) {
            return true;
        }
        this.setState('requesting');
        try {
            const access = await (navigator as MidiNavigator).requestMIDIAccess!({ sysex: false });
            this.access = access;
            write(GRANTED_KEY, '1');
            access.onstatechange = () => this.refresh();
            this.state = 'on';
            this.refresh();
            return true;
        } catch (error) {
            console.warn('MIDI access was not granted', error);
            write(GRANTED_KEY, '0');
            this.setState('denied');
            return false;
        }
    }

    /** Turns MIDI back on by itself when it was granted before and the browser would not ask again. */
    async restore(): Promise<boolean> {
        if (this.state === 'unsupported' || !MidiInput.wasGranted()) {
            return false;
        }
        try {
            const status = await navigator.permissions?.query({ name: 'midi' as PermissionName });
            if (status && status.state !== 'granted') {
                return false;
            }
        } catch {
            // No Permissions API for MIDI here (Firefox asks through an add-on anyway): the earlier grant decides.
        }
        return this.enable();
    }

    /** Switches one input on or off; remembered for the next visit. */
    setEnabled(id: string, enabled: boolean): void {
        const device = this.devices.find((candidate) => candidate.id === id);
        if (!device) {
            return;
        }
        device.enabled = enabled;
        for (const key of [device.id, `name:${device.name}`]) {
            if (enabled) {
                this.disabled.delete(key);
            } else {
                this.disabled.add(key);
            }
        }
        write(DISABLED_KEY, JSON.stringify([...this.disabled]));
        this.refresh();
    }

    /** Stops listening (the page goes away). */
    dispose(): void {
        for (const input of this.listening.values()) {
            input.onmidimessage = null;
        }
        this.listening.clear();
        if (this.access) {
            this.access.onstatechange = null;
        }
        this.access = null;
    }

    private isEnabled(input: MIDIInput): boolean {
        return !this.disabled.has(input.id) && !this.disabled.has(`name:${input.name ?? ''}`);
    }

    /** Brings the device list and the listeners up to date with what is plugged in. */
    private refresh(): void {
        const access = this.access;
        if (!access) {
            return;
        }
        const present = new Set<string>();
        access.inputs.forEach((input) => {
            const connected = input.state === 'connected';
            const enabled = this.isEnabled(input);
            present.add(input.id);
            const device = this.devices.find((candidate) => candidate.id === input.id);
            const next = { id: input.id, name: input.name || 'MIDI input', manufacturer: input.manufacturer ?? '', connected, enabled };
            if (device) {
                Object.assign(device, next);
            } else {
                this.devices.push(next);
            }
            if (connected && enabled) {
                this.listen(input);
            } else {
                this.stopListening(input.id);
            }
        });
        for (const device of this.devices) {
            if (!present.has(device.id)) {
                device.connected = false;
                this.stopListening(device.id);
            }
        }
        this.options.onChange();
    }

    private listen(input: MIDIInput): void {
        if (this.listening.get(input.id) === input) {
            return;
        }
        // Setting the handler opens the port.
        input.onmidimessage = (event: MIDIMessageEvent) => {
            if (event.data) {
                this.options.onMessage(input.id, event.data, event.timeStamp);
            }
        };
        this.listening.set(input.id, input);
    }

    private stopListening(id: string): void {
        const input = this.listening.get(id);
        if (!input) {
            return;
        }
        input.onmidimessage = null;
        this.listening.delete(id);
        this.options.onInputGone?.(id);
    }

    private setState(state: MidiAccessState): void {
        this.state = state;
        this.options.onChange();
    }
}
