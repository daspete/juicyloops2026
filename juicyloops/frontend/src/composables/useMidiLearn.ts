import type { AutomationTarget } from '@/juicyloops/automation';
import { paramKey, type MidiMapping } from '@/juicyloops/midi/mappings';
import { inject, provide, ref, shallowRef, type InjectionKey, type Ref } from 'vue';

/**
 * The knob side of MIDI learn, apart from `useMidi` so a knob does not pull in the engine: whether learn mode is on,
 * which knob waits for a controller, the session's mappings (kept in sync by `useMidi`), and a pulse for knobs that
 * keep their own copy of a value (effect racks, buses) when a controller changed it.
 *
 * Which owner a knob belongs to (a track, a container bus, the master) comes from the nearest `provideLearnOwner`,
 * so the effect knobs deep inside a rack need no extra props.
 */

/** A knob that can be learned: whose parameter, and which. */
export interface LearnTarget {
    target: AutomationTarget;
    param: string;
    /** What the mapping list calls it. */
    label?: string;
}

/** Learn mode: every learnable knob is highlighted, a click picks one, the next controller moved is mapped to it. */
const isLearning = ref(false);
/** The knob waiting for a controller. */
const learnTarget = shallowRef<LearnTarget | null>(null);
/** The session's mappings (`SessionState.midiMappings`), mirrored here by `useMidi`. */
const mappings = shallowRef<readonly MidiMapping[]>([]);
/** The last value a controller set: knobs with their own copy of the value follow it. */
const paramChange = shallowRef<{ key: string; value: number } | null>(null);

const setLearning = (on: boolean): void => {
    isLearning.value = on;
    if (!on) {
        learnTarget.value = null;
    }
};

/** Picks a knob to learn, or drops it when it was already picked. */
const selectLearnTarget = (target: LearnTarget): void => {
    const current = learnTarget.value;
    learnTarget.value = current && paramKey(current.target, current.param) === paramKey(target.target, target.param) ? null : target;
};

/** Tells the knobs of a parameter that a controller set it. */
const announceChange = (target: AutomationTarget, param: string, value: number): void => {
    paramChange.value = { key: paramKey(target, param), value };
};

const OWNER: InjectionKey<Ref<AutomationTarget | null>> = Symbol('midiLearnOwner');

/** Makes `target` the owner of every learnable knob below this component (a track's panel, a bus strip). */
export const provideLearnOwner = (target: Ref<AutomationTarget | null>): void => provide(OWNER, target);

/** The owner a knob's parameter belongs to, or null outside any (the knob is then not learnable). */
export const injectLearnOwner = (): Ref<AutomationTarget | null> => inject(OWNER, ref(null));

export const useMidiLearn = () => ({ isLearning, setLearning, learnTarget, selectLearnTarget, mappings, paramChange, announceChange });
