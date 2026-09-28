/**
 * A fake Web MIDI API for Playwright: `installFakeMidi(page)` replaces `navigator.requestMIDIAccess` before the app
 * loads (`addInitScript`), and the page gets `window.__fakeMidi` to drive it:
 *
 *     __fakeMidi.send([0x90, 60, 127])            // note-on middle C from the default input, now
 *     __fakeMidi.send([0x80, 60, 0], 'kbd-2')     // from another input
 *     __fakeMidi.send([0x90, 60, 127], null, t)   // dispatched now, stamped as arrived at performance time t
 *     __fakeMidi.plug('kbd-2', 'Second Keys')     // hot-plug (fires `statechange`)
 *     __fakeMidi.unplug('kbd-2')
 *     __fakeMidi.requests                          // how often access was asked for
 *     __fakeMidi.sent                              // every message sent: { data, timeStamp, input }
 *
 * `send` dispatches synchronously to the input's `onmidimessage` with `timeStamp = performance.now()` (the clock the
 * real API uses) and returns that time stamp, so a test can measure from the moment the message "arrived".
 * Node side, `sendMidi(page, bytes)` does the same through `page.evaluate`.
 *
 * Used by `scripts/midi/live.mjs` (Phase 3 of notes/midi-recording.md) and `scripts/midi/record.mjs` (Phase 4).
 */

/** The script that runs in the page before any of its own. Self-contained: it is serialized into the page. */
function fakeMidiInit(options) {
    const inputs = new Map();
    const accessListeners = new Set();
    const state = { requests: 0, sent: [], deny: !!options.deny, access: null };

    const makeInput = (id, name) => {
        const input = {
            id,
            name,
            manufacturer: 'JuicyLoops test',
            type: 'input',
            version: '1',
            state: 'connected',
            connection: 'closed',
            onmidimessage: null,
            onstatechange: null,
            open: () => Promise.resolve(input),
            close: () => Promise.resolve(input),
            addEventListener: () => {},
            removeEventListener: () => {},
        };
        return input;
    };

    const fireStateChange = (port) => {
        const event = { port };
        if (state.access?.onstatechange) {
            state.access.onstatechange(event);
        }
        for (const listener of accessListeners) {
            listener(event);
        }
    };

    const plug = (id, name = id) => {
        const input = makeInput(id, name);
        inputs.set(id, input);
        fireStateChange(input);
        return input;
    };

    const unplug = (id) => {
        const input = inputs.get(id);
        if (!input) {
            return;
        }
        input.state = 'disconnected';
        fireStateChange(input);
    };

    for (const [id, name] of options.inputs) {
        inputs.set(id, makeInput(id, name));
    }

    const send = (data, id = options.inputs[0]?.[0], at) => {
        const input = inputs.get(id ?? options.inputs[0]?.[0]);
        // A real message carries the time it arrived, which can be a moment before it is dispatched: `at` sets it.
        const timeStamp = typeof at === 'number' ? at : performance.now();
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        state.sent.push({ data: Array.from(bytes), timeStamp, input: id ?? options.inputs[0]?.[0] });
        if (input && input.state === 'connected' && input.onmidimessage) {
            input.onmidimessage({ data: bytes, timeStamp, target: input });
        }
        return timeStamp;
    };

    Object.defineProperty(navigator, 'requestMIDIAccess', {
        configurable: true,
        value: (requestOptions) => {
            state.requests++;
            if (state.deny) {
                return Promise.reject(new DOMException('MIDI denied (fake)', 'SecurityError'));
            }
            state.access ??= {
                sysexEnabled: !!requestOptions?.sysex,
                // A live view, as the real `MIDIInputMap` is.
                inputs: { forEach: (fn) => inputs.forEach((input, key) => fn(input, key, inputs)), get size() { return inputs.size; }, get: (key) => inputs.get(key) },
                outputs: new Map(),
                onstatechange: null,
                addEventListener: (type, listener) => type === 'statechange' && accessListeners.add(listener),
                removeEventListener: (type, listener) => accessListeners.delete(listener),
            };
            return Promise.resolve(state.access);
        },
    });

    // So `useMidi.restore()` (a grant from an earlier visit) sees a granted permission, as Chromium would say.
    const query = navigator.permissions?.query?.bind(navigator.permissions);
    if (query) {
        navigator.permissions.query = (descriptor) =>
            descriptor?.name === 'midi' ? Promise.resolve({ state: state.deny ? 'denied' : 'granted', onchange: null }) : query(descriptor);
    }

    window.__fakeMidi = {
        send,
        plug,
        unplug,
        get requests() {
            return state.requests;
        },
        get sent() {
            return state.sent;
        },
        set deny(value) {
            state.deny = value;
        },
    };
}

/**
 * Installs the fake before the page's scripts run. `inputs` are `[id, name]` pairs (default: one keyboard).
 * `deny: true` makes `requestMIDIAccess` reject, as a refused permission does.
 */
export const installFakeMidi = async (page, { inputs = [['fake-kbd', 'Fake Keyboard']], deny = false } = {}) => {
    await page.addInitScript(fakeMidiInit, { inputs, deny });
};

/** Sends one message from the page's fake input (or `input`). Resolves with its `performance.now()` time stamp. */
export const sendMidi = (page, data, input) => page.evaluate(([bytes, id]) => window.__fakeMidi.send(bytes, id ?? undefined), [data, input ?? null]);

/** Handy message builders (channel 0..15). */
export const noteOn = (note, velocity = 127, channel = 0) => [0x90 | channel, note, velocity];
export const noteOff = (note, channel = 0) => [0x80 | channel, note, 0];
export const controlChange = (cc, value, channel = 0) => [0xb0 | channel, cc, value];
export const sustain = (down, channel = 0) => controlChange(64, down ? 127 : 0, channel);
/** `value` -1..1. */
export const pitchBend = (value, channel = 0) => {
    const raw = Math.max(0, Math.min(16383, Math.round(8192 + value * (value >= 0 ? 8191 : 8192))));
    return [0xe0 | channel, raw & 0x7f, raw >> 7];
};
