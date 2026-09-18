import type { SessionState } from './sequencer';
import type { ContainerState } from './trackContainer';
import type { TrackState } from './tracks/BaseTrack';
import type { SampleTrackState } from './tracks/SampleTrack';

/**
 * The save file: everything the session holds, samples and microphone recordings included, in one file.
 *
 * Layout (all integers little endian):
 *
 *     "JUICYLPS"   8 bytes   magic
 *     u32          4 bytes   byte length of the header
 *     header       JSON, UTF-8: the session with every sample replaced by the index of an asset
 *     assets       the raw audio of every sample, one after the other, in the order the header lists them
 *
 * The audio is written as it came in (a dropped file stays that file, a recording stays what the recorder
 * produced), so nothing is re-encoded and a saved file opens sounding exactly like it did. Two tracks that
 * share one sample (a duplicated track) share one asset.
 */

export const SESSION_FILE_EXTENSION = '.juicyloops';
export const SESSION_FILE_MIME = 'application/x-juicyloops';

const MAGIC = 'JUICYLPS';
const FORMAT_VERSION = 1;

/** What is saved and loaded: the session as history keeps it, plus what the UI owns. */
export interface SavedSession {
    name: string;
    bpm: number;
    session: SessionState;
}

interface AssetEntry {
    type: string;
    size: number;
}

/** `sampleBlob` is not JSON, so the header points at an asset instead. */
type StoredTrackState = Omit<SampleTrackState, 'sampleBlob'> & { sampleAsset?: number };

interface Header {
    format: 'juicyloops';
    version: number;
    savedAt: string;
    name: string;
    bpm: number;
    session: Omit<SessionState, 'containers'> & { containers: (Omit<ContainerState, 'tracks'> & { tracks: StoredTrackState[] })[] };
    assets: AssetEntry[];
}

const hasSampleBlob = (track: TrackState): track is SampleTrackState => 'sampleBlob' in track;

/** Packs a session into a file. Blobs are written by reference, so no audio is copied into memory here. */
export const packSession = (saved: SavedSession): Blob => {
    const assets: AssetEntry[] = [];
    const parts: Blob[] = [];
    const indexOf = new Map<Blob, number>();

    const storeBlob = (blob: Blob): number => {
        let index = indexOf.get(blob);
        if (index === undefined) {
            index = assets.length;
            indexOf.set(blob, index);
            assets.push({ type: blob.type, size: blob.size });
            parts.push(blob);
        }
        return index;
    };

    const containers = saved.session.containers.map((container) => ({
        ...container,
        tracks: container.tracks.map((track): StoredTrackState => {
            if (!hasSampleBlob(track)) {
                return track as StoredTrackState;
            }
            const { sampleBlob, ...rest } = track;
            return sampleBlob ? { ...rest, sampleAsset: storeBlob(sampleBlob) } : rest;
        }),
    }));

    const header: Header = {
        format: 'juicyloops',
        version: FORMAT_VERSION,
        savedAt: new Date().toISOString(),
        name: saved.name,
        bpm: saved.bpm,
        session: { ...saved.session, containers },
        assets,
    };

    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const length = new DataView(new ArrayBuffer(4));
    length.setUint32(0, headerBytes.byteLength, true);

    return new Blob([new TextEncoder().encode(MAGIC), length.buffer, headerBytes, ...parts], { type: SESSION_FILE_MIME });
};

export class SessionFileError extends Error {}

/** Reads a file written by `packSession`. Throws a `SessionFileError` with a readable message when it is not one. */
export const unpackSession = (data: ArrayBuffer): SavedSession => {
    const bytes = new Uint8Array(data);
    const magicLength = MAGIC.length;
    if (bytes.byteLength < magicLength + 4 || new TextDecoder().decode(bytes.subarray(0, magicLength)) !== MAGIC) {
        throw new SessionFileError('This is not a JuicyLoops file.');
    }

    const headerLength = new DataView(data).getUint32(magicLength, true);
    const headerStart = magicLength + 4;
    const assetsStart = headerStart + headerLength;
    if (assetsStart > bytes.byteLength) {
        throw new SessionFileError('The file is damaged: its header is cut off.');
    }

    let header: Header;
    try {
        header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, assetsStart)));
    } catch {
        throw new SessionFileError('The file is damaged: its header cannot be read.');
    }
    if (header.format !== 'juicyloops' || !Array.isArray(header.assets) || !header.session?.containers) {
        throw new SessionFileError('This is not a JuicyLoops file.');
    }
    if (header.version > FORMAT_VERSION) {
        throw new SessionFileError('This file was saved by a newer version of JuicyLoops.');
    }

    let offset = assetsStart;
    const blobs = header.assets.map((asset) => {
        const end = offset + asset.size;
        if (end > bytes.byteLength) {
            throw new SessionFileError('The file is damaged: a sample is cut off.');
        }
        const blob = new Blob([data.slice(offset, end)], { type: asset.type });
        offset = end;
        return blob;
    });

    const containers: ContainerState[] = header.session.containers.map((container) => ({
        ...container,
        tracks: container.tracks.map((track): TrackState => {
            if (track.type !== 'sampler' && track.type !== 'microphone') {
                return track as TrackState;
            }
            const { sampleAsset, ...rest } = track;
            const sampleBlob = sampleAsset === undefined ? null : blobs[sampleAsset];
            if (sampleAsset !== undefined && !sampleBlob) {
                throw new SessionFileError('The file is damaged: a sample is missing.');
            }
            const restored: SampleTrackState = { ...rest, sampleBlob: sampleBlob ?? null };
            return restored;
        }),
    }));

    return {
        name: typeof header.name === 'string' ? header.name : '',
        bpm: header.bpm,
        session: { ...header.session, containers },
    };
};

/** The file name for a session name: the name, made safe for a file system, with the extension. */
export const sessionFileName = (name: string): string => {
    const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
    return `${safe || 'untitled'}${SESSION_FILE_EXTENSION}`;
};

/** The session name for a file name: what is before the extension. */
export const sessionNameOf = (fileName: string): string => fileName.replace(/\.[^.]+$/, '').trim();
