/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const DB_NAME = "nivris_message_cache";
const DB_VERSION = 1;
const STORE_MESSAGES = "messages";
const STORE_META = "meta";

export interface StoredNivrisMessage {
    id: string;
    roomId: string;
    roomName: string;
    sender: string;
    senderName: string;
    ts: number;
    body: string;
    threadRootId?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
                    const store = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
                    store.createIndex("ts", "ts", { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_META)) {
                    db.createObjectStore(STORE_META, { keyPath: "key" });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

export async function putMessages(messages: StoredNivrisMessage[]): Promise<void> {
    if (!messages.length) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, "readwrite");
        const store = tx.objectStore(STORE_MESSAGES);
        for (const msg of messages) store.put(msg);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function putMessage(message: StoredNivrisMessage): Promise<void> {
    return putMessages([message]);
}

export async function getMessagesSince(sinceTs: number): Promise<StoredNivrisMessage[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, "readonly");
        const index = tx.objectStore(STORE_MESSAGES).index("ts");
        const range = IDBKeyRange.lowerBound(sinceTs);
        const results: StoredNivrisMessage[] = [];
        const req = index.openCursor(range);
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                results.push(cursor.value as StoredNivrisMessage);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Naive local keyword search over the cached messages (room name or body containing any of the
 * given keywords, case-insensitively), most recent first. Used to pull only the relevant slice of
 * cached history into a prompt on demand, instead of ever dumping the whole cache.
 */
export async function searchMessages(keywords: string[], limit = 40): Promise<StoredNivrisMessage[]> {
    if (!keywords.length) return [];
    const lowerKeywords = keywords.map((k) => k.toLowerCase());

    const all = await getMessagesSince(0);
    const matches = all.filter((m) => {
        const haystack = `${m.roomName} ${m.body}`.toLowerCase();
        return lowerKeywords.some((k) => haystack.includes(k));
    });

    matches.sort((a, b) => b.ts - a.ts);
    return matches.slice(0, limit);
}

export async function pruneOlderThan(cutoffTs: number): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, "readwrite");
        const index = tx.objectStore(STORE_MESSAGES).index("ts");
        const range = IDBKeyRange.upperBound(cutoffTs, true);
        const req = index.openCursor(range);
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function clearAllMessages(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, "readwrite");
        tx.objectStore(STORE_MESSAGES).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function getMeta(key: string): Promise<string | undefined> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_META, "readonly");
        const req = tx.objectStore(STORE_META).get(key);
        req.onsuccess = () => resolve((req.result as { key: string; value: string } | undefined)?.value);
        req.onerror = () => reject(req.error);
    });
}

export async function setMeta(key: string, value: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_META, "readwrite");
        tx.objectStore(STORE_META).put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
