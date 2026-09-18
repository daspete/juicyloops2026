import { getContext } from 'tone';

/**
 * Decodes raw audio data with Tone's shared audio context.
 * The browser detaches the buffer it decodes, so we pass a copy and the caller keeps its own data intact.
 */
export const decodeAudio = (data: ArrayBuffer): Promise<AudioBuffer> => getContext().decodeAudioData(data.slice(0));

export const decodeBlob = async (blob: Blob): Promise<AudioBuffer> => decodeAudio(await blob.arrayBuffer());

export const createId = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11);
