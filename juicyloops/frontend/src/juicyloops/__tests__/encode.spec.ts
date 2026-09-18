import { describe, expect, it } from 'vitest';
import { encodeMp3, encodeWav, type PcmAudio } from '../encode';

const audio = (channels: number, length: number, sampleRate = 44100): PcmAudio => {
    const planes = Array.from({ length: channels }, (_, channel) => Float32Array.from({ length }, (_, i) => (channel === 0 ? Math.sin(i / 10) : Math.cos(i / 10))));
    return { sampleRate, numberOfChannels: channels, length, getChannelData: (channel) => planes[channel]! };
};

const ascii = (view: DataView, offset: number, count: number) => String.fromCharCode(...Array.from({ length: count }, (_, i) => view.getUint8(offset + i)));

describe('encodeWav', () => {
    it('writes a 16 bit PCM header that describes the data', async () => {
        const blob = encodeWav(audio(2, 1000, 48000));
        expect(blob.type).toBe('audio/wav');
        expect(blob.size).toBe(44 + 1000 * 4);

        const view = new DataView(await blob.arrayBuffer());
        expect(ascii(view, 0, 4)).toBe('RIFF');
        expect(view.getUint32(4, true)).toBe(36 + 4000);
        expect(ascii(view, 8, 4)).toBe('WAVE');
        expect(view.getUint16(20, true)).toBe(1);
        expect(view.getUint16(22, true)).toBe(2);
        expect(view.getUint32(24, true)).toBe(48000);
        expect(view.getUint32(28, true)).toBe(48000 * 4);
        expect(view.getUint16(32, true)).toBe(4);
        expect(view.getUint16(34, true)).toBe(16);
        expect(ascii(view, 36, 4)).toBe('data');
        expect(view.getUint32(40, true)).toBe(4000);
    });

    it('interleaves the channels and clips samples outside -1..1', async () => {
        const planes = [Float32Array.from([0, 0.5, 2]), Float32Array.from([-1, -0.5, -2])];
        const blob = encodeWav({ sampleRate: 44100, numberOfChannels: 2, length: 3, getChannelData: (channel) => planes[channel]! });
        const view = new DataView(await blob.arrayBuffer());
        const samples = Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true));
        expect(samples).toEqual([0, -32768, Math.round(0.5 * 32767), -16384, 32767, -32768]);
    });

    it('writes mono as one channel', () => {
        expect(encodeWav(audio(1, 10)).size).toBe(44 + 20);
    });
});

describe('encodeMp3', () => {
    it('produces an MPEG stream with frame sync bytes', async () => {
        const blob = await encodeMp3(audio(2, 44100), 128);
        expect(blob.type).toBe('audio/mpeg');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        expect(bytes.length).toBeGreaterThan(1000);
        // The first frame header starts with 11 sync bits.
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]! & 0xe0).toBe(0xe0);
    });
});
