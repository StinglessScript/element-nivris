/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { EventEmitter } from "events";

export const NIVRIS_DONE_STORE_CHANGE_EVENT = "change";

const STORAGE_KEY = "mx_nivris_done_message_ids";

function load(): Set<string> {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
        return new Set();
    }
}

function save(ids: Set<string>): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(ids)));
}

/** Tracks which feed items (by their underlying message id — a stable Matrix event id) the user
 * has marked "Đã xong" — e.g. an @mention they've already handled. Messages themselves are
 * recomputed fresh on every poll (see computeTrackerInsights.ts), so this can't live as component
 * state or on the message record; same persisted-singleton pattern as NivrisTaskStore. */
class NivrisDoneStore extends EventEmitter {
    private static internalInstance: NivrisDoneStore;

    private ids: Set<string> = load();

    private constructor() {
        super();
    }

    public static get instance(): NivrisDoneStore {
        if (!NivrisDoneStore.internalInstance) {
            NivrisDoneStore.internalInstance = new NivrisDoneStore();
        }
        return NivrisDoneStore.internalInstance;
    }

    public isDone(id: string): boolean {
        return this.ids.has(id);
    }

    public getAll(): ReadonlySet<string> {
        return this.ids;
    }

    public setDone(id: string, done: boolean): void {
        if (done === this.ids.has(id)) return;
        this.ids = new Set(this.ids);
        if (done) this.ids.add(id);
        else this.ids.delete(id);
        save(this.ids);
        this.emit(NIVRIS_DONE_STORE_CHANGE_EVENT);
    }
}

export default NivrisDoneStore;
