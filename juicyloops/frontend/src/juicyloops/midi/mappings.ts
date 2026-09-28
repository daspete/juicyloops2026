import { sameTarget, toValue, type AutomationParam, type AutomationTarget } from '../automation';

/**
 * MIDI learn: which controller (CC) turns which knob. The mappings belong to the session (`SessionState.midiMappings`),
 * so they are saved with it and undo/redo covers them. Pure functions over plain arrays.
 */

export interface MidiMapping {
    /** Controller number, 0..127. */
    cc: number;
    /** 0..15, or every channel. */
    channel: number | 'all';
    /** Whose parameter: a track, a container bus or the master. */
    target: AutomationTarget;
    /** The parameter's automation key (`volume`, `envelope.attack`, `fx.reverb.wet`, ...). */
    param: string;
}

/** Whether a mapping listens to controller `cc` on `channel`. */
export const listensTo = (mapping: MidiMapping, cc: number, channel: number): boolean =>
    mapping.cc === cc && (mapping.channel === 'all' || mapping.channel === channel);

/** The mappings a controller message drives. */
export const mappingsFor = (mappings: readonly MidiMapping[], cc: number, channel: number): MidiMapping[] =>
    mappings.filter((mapping) => listensTo(mapping, cc, channel));

/** Whether two mappings drive the same parameter. */
export const sameParam = (a: Pick<MidiMapping, 'target' | 'param'>, b: Pick<MidiMapping, 'target' | 'param'>): boolean =>
    a.param === b.param && sameTarget(a.target, b.target);

/** Whether two mappings listen to the same controller (one of them on every channel counts as overlapping). */
const sameController = (a: MidiMapping, b: MidiMapping): boolean =>
    a.cc === b.cc && (a.channel === 'all' || b.channel === 'all' || a.channel === b.channel);

/**
 * The list with `mapping` learned: a parameter has one controller, and a controller turns one parameter, so any
 * mapping of the same parameter or the same controller goes. Returns a new array.
 */
export const learnMapping = (mappings: readonly MidiMapping[], mapping: MidiMapping): MidiMapping[] => [
    ...mappings.filter((other) => !sameParam(other, mapping) && !sameController(other, mapping)),
    { ...mapping, target: { ...mapping.target } },
];

/** The list without the mapping at `index`. */
export const removeMapping = (mappings: readonly MidiMapping[], index: number): MidiMapping[] => mappings.filter((_, i) => i !== index);

/** The mapping of a parameter, if it has one. */
export const mappingOf = (mappings: readonly MidiMapping[], target: AutomationTarget, param: string): MidiMapping | undefined =>
    mappings.find((mapping) => sameParam(mapping, { target, param }));

/** The value a controller position (0..127) sets on a parameter: the knob's own range and curve, snapped to its step. */
export const controllerValue = (param: AutomationParam, value: number): number => toValue(param, Math.min(127, Math.max(0, value)) / 127);

/** A copy for history and the session file, dropping anything that is not a valid mapping. */
export const cloneMappings = (mappings: readonly MidiMapping[] | undefined): MidiMapping[] =>
    (mappings ?? [])
        .filter((mapping) => Number.isInteger(mapping.cc) && mapping.cc >= 0 && mapping.cc < 128 && typeof mapping.param === 'string' && !!mapping.target)
        .map((mapping) => ({ cc: mapping.cc, channel: mapping.channel === 'all' ? 'all' : mapping.channel, target: { ...mapping.target }, param: mapping.param }));

/** A stable key for a mapping's parameter, for looking knobs up. */
export const paramKey = (target: AutomationTarget, param: string): string =>
    `${target.kind === 'master' ? 'master' : target.kind === 'container' ? `c:${target.containerId}` : `t:${target.containerId}:${target.trackId}`}|${param}`;
