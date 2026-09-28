/**
 * Remembers the folders of the sample browser between visits. A directory handle of the File System Access API can be
 * put into IndexedDB (not localStorage) and comes back as the same folder; reading it again needs the user's permission
 * once per visit. Everything here fails soft: without IndexedDB the folders simply last for this visit.
 */

export interface StoredFolder {
    key: string;
    name: string;
    handle: FileSystemDirectoryHandle;
    addedAt: number;
}

const DB_NAME = 'juicyloops';
const DB_VERSION = 1;
const STORE = 'sample-folders';

let opening: Promise<IDBDatabase | null> | null = null;

const request = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

const open = (): Promise<IDBDatabase | null> => {
    opening ??= new Promise((resolve) => {
        try {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) {
                    req.result.createObjectStore(STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    return opening;
};

const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => {
    const db = await open();
    if (!db) {
        return null;
    }
    try {
        return await request(run(db.transaction(STORE, mode).objectStore(STORE)));
    } catch {
        return null;
    }
};

/** Every remembered folder, in the order they were added. */
export const loadFolders = async (): Promise<StoredFolder[]> => {
    const folders = (await withStore('readonly', (store) => store.getAll() as IDBRequest<StoredFolder[]>)) ?? [];
    return folders.sort((a, b) => a.addedAt - b.addedAt);
};

export const saveFolder = async (folder: StoredFolder): Promise<void> => {
    await withStore('readwrite', (store) => store.put(folder));
};

export const deleteFolder = async (key: string): Promise<void> => {
    await withStore('readwrite', (store) => store.delete(key));
};
