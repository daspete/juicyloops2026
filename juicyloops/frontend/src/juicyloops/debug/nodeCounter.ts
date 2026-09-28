import { ToneAudioNode } from 'tone';

/**
 * Dev-only count of live Tone audio nodes: constructed minus disposed.
 *
 * Makes leaks visible (nodes that are created lazily and never disposed, or racks that outlive their track), and
 * gives `scripts/perf/run.mjs` a number to compare between engine versions. In the console:
 *
 *     __jlNodeCount        live nodes right now
 *     __jlNodeCounts()     live nodes by class name, largest first
 *
 * Everything sits behind `import.meta.env.DEV`, so production builds (and the SSR build of the marketing pages)
 * compile this module down to nothing and Tone stays untouched.
 */

/** What the counter puts on `window`. */
export interface NodeCounterGlobals {
    readonly __jlNodeCount: number;
    __jlNodeCounts: () => Record<string, number>;
}

if (import.meta.env.DEV) {
    /*
     * Tone has no construction hook, but every node runs `this.context = ...` once in the `ToneWithContext`
     * constructor. An accessor on `ToneAudioNode.prototype` catches that assignment for audio nodes only (Params,
     * the transport and the like are not counted), counts it and puts a plain own property on the instance, so
     * reads and later writes never come back here.
     */
    const live = new WeakSet<object>();
    const byName = new Map<string, number>();
    let count = 0;

    const nameOf = (node: object): string => node.constructor?.name || 'unknown';
    const bump = (name: string, delta: number): void => {
        const next = (byName.get(name) ?? 0) + delta;
        if (next > 0) {
            byName.set(name, next);
        } else {
            byName.delete(name);
        }
    };

    const prototype = ToneAudioNode.prototype as unknown as Record<string, unknown>;

    Object.defineProperty(prototype, 'context', {
        configurable: true,
        get(): undefined {
            return undefined;
        },
        set(this: object, value: unknown) {
            Object.defineProperty(this, 'context', { value, writable: true, configurable: true, enumerable: true });
            if (!live.has(this)) {
                live.add(this);
                count++;
                bump(nameOf(this), 1);
            }
        },
    });

    /* Every subclass ends its `dispose` in `super.dispose()`, which lands here. The WeakSet ignores a second dispose. */
    const dispose = prototype.dispose as (this: object) => unknown;
    prototype.dispose = function (this: object) {
        if (live.delete(this)) {
            count--;
            bump(nameOf(this), -1);
        }
        return dispose.call(this);
    };

    Object.defineProperty(globalThis, '__jlNodeCount', { configurable: true, get: () => count });
    (globalThis as unknown as NodeCounterGlobals).__jlNodeCounts = () => Object.fromEntries([...byName].sort((a, b) => b[1] - a[1]));
}
