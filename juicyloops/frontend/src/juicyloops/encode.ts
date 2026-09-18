/**
 * Turning rendered audio into a file. WAV is written here, MP3 by an encoder that is only loaded when asked for.
 */

export type ExportFormat = 'wav' | 'mp3';

export const EXPORT_FORMATS: readonly { key: ExportFormat; label: string; hint: string; mime: string }[] = [
    { key: 'wav', label: 'WAV', hint: 'Lossless, 16 bit. The one for further editing.', mime: 'audio/wav' },
    { key: 'mp3', label: 'MP3', hint: 'Small, for sharing. Encoding takes a moment.', mime: 'audio/mpeg' },
];

export const MP3_BITRATES: readonly number[] = [128, 192, 320];
export const DEFAULT_MP3_BITRATE = 192;

/** What the encoders need from an `AudioBuffer`, so plain objects can stand in for one in tests. */
export interface PcmAudio {
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    readonly length: number;
    getChannelData(channel: number): Float32Array;
}

/** A float sample (-1..1) as a signed 16 bit integer, clipped. */
const toInt16 = (sample: number): number => {
    const clipped = Math.max(-1, Math.min(1, sample));
    return Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
};

/** One channel of 16 bit samples. */
const channelToInt16 = (audio: PcmAudio, channel: number): Int16Array => {
    const data = audio.getChannelData(channel);
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
        out[i] = toInt16(data[i]!);
    }
    return out;
};

/** A WAV file: RIFF header and interleaved 16 bit PCM. At most two channels are written. */
export const encodeWav = (audio: PcmAudio): Blob => {
    const channels = Math.min(2, Math.max(1, audio.numberOfChannels));
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const dataSize = audio.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeAscii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, audio.sampleRate, true);
    view.setUint32(28, audio.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample
    writeAscii(36, 'data');
    view.setUint32(40, dataSize, true);

    const planes = Array.from({ length: channels }, (_, channel) => channelToInt16(audio, channel));
    let offset = 44;
    for (let i = 0; i < audio.length; i++) {
        for (const plane of planes) {
            view.setInt16(offset, plane[i]!, true);
            offset += 2;
        }
    }

    return new Blob([buffer], { type: 'audio/wav' });
};

/** Samples per call to the MP3 encoder; a multiple of an MP3 frame keeps it efficient. */
const MP3_BLOCK = 1152 * 8;

/** An MP3 file. The encoder is a separate chunk that only loads the first time this runs. */
export const encodeMp3 = async (audio: PcmAudio, kbps = DEFAULT_MP3_BITRATE): Promise<Blob> => {
    const { Mp3Encoder } = await import('@breezystack/lamejs');
    const channels = Math.min(2, Math.max(1, audio.numberOfChannels));
    const encoder = new Mp3Encoder(channels, audio.sampleRate, kbps);
    const left = channelToInt16(audio, 0);
    const right = channels === 2 ? channelToInt16(audio, 1) : undefined;

    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < audio.length; offset += MP3_BLOCK) {
        const end = Math.min(audio.length, offset + MP3_BLOCK);
        const encoded = encoder.encodeBuffer(left.subarray(offset, end), right?.subarray(offset, end));
        if (encoded.length) {
            parts.push(encoded);
        }
    }
    const last = encoder.flush();
    if (last.length) {
        parts.push(last);
    }

    return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
};

export const encodeAudio = (audio: PcmAudio, format: ExportFormat, kbps?: number): Promise<Blob> => (format === 'wav' ? Promise.resolve(encodeWav(audio)) : encodeMp3(audio, kbps));
