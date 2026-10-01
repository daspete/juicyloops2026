/**
 * What the main thread and the recorder worklet (`recorderProcessor.ts`) say to each other. The recorder taps the
 * master output for a real-time export (`liveRender.ts`).
 *
 * No runtime imports on purpose, like `synthProtocol.ts`: the processor imports this module's types only.
 */

/** The name the processor registers under. `recorderProcessor.ts` repeats it (it may not import anything at runtime). */
export const RECORDER_PROCESSOR = 'juicyloops-recorder';

/**
 * To the processor. `record` arms it: from the absolute context frame `frame` on it keeps `frames` frames of its
 * input. `cancel` drops a recording in progress; `dispose` lets the node go.
 */
export type RecorderCommand = { type: 'record'; frame: number; frames: number } | { type: 'cancel' } | { type: 'dispose' };

/**
 * From the processor. `chunk` carries recorded frames (both sides, each `left.length` long) starting `offset` frames
 * into the recording; `done` follows the last chunk. `late` means the command arrived after its start frame had
 * already played: `missed` frames are gone, so nothing was recorded.
 */
export type RecorderEvent =
    | { type: 'chunk'; offset: number; left: Float32Array; right: Float32Array }
    | { type: 'done'; frames: number }
    | { type: 'late'; missed: number };
