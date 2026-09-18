import { getContext } from 'tone';

/**
 * Decodes raw audio data with Tone's shared audio context.
 * The browser detaches the buffer it decodes, so we pass a copy and the caller keeps its own data intact.
 */
export const decodeAudio = (data: ArrayBuffer): Promise<AudioBuffer> => getContext().decodeAudioData(data.slice(0));

/** Decodes with the context that is current when the call is made, not the one current when the bytes arrive. */
export const decodeBlob = async (blob: Blob): Promise<AudioBuffer> => {
    const context = getContext();
    const data = await blob.arrayBuffer();
    return context.decodeAudioData(data.slice(0));
};

export const createId = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11);
