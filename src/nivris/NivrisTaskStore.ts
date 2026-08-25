/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { EventEmitter } from "events";

export const NIVRIS_TASK_STORE_CHANGE_EVENT = "change";

export type NivrisTaskStatus = "todo" | "doing" | "done" | "late";

export interface NivrisTask {
    id: string;
    title: string;
    assigneeName: string;
    /** Links back to the person tracker this task came from, if scanned (not set for manually added cards). */
    trackerId?: string;
    status: NivrisTaskStatus;
    /** "YYYY-MM-DD" (local) — which day's board this card belongs to. */
    date: string;
    createdAt: number;
}

const STORAGE_KEY = "mx_nivris_tasks";

let idCounter = 0;
function nextId(): string {
    idCounter++;
    return `nivris-task-${Date.now()}-${idCounter}`;
}

export function todayKey(d = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function load(): NivrisTask[] {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as NivrisTask[]) : [];
    } catch {
        return [];
    }
}

function save(tasks: NivrisTask[]): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

/** Holds Trello-style task cards for the daily work board, grouped by date. Persisted locally,
 * same pattern as NivrisTrackerStore. */
class NivrisTaskStore extends EventEmitter {
    private static internalInstance: NivrisTaskStore;

    private tasks: NivrisTask[] = load();

    private constructor() {
        super();
    }

    public static get instance(): NivrisTaskStore {
        if (!NivrisTaskStore.internalInstance) {
            NivrisTaskStore.internalInstance = new NivrisTaskStore();
        }
        return NivrisTaskStore.internalInstance;
    }

    public getTasksForDate(date: string): NivrisTask[] {
        return this.tasks.filter((t) => t.date === date);
    }

    public addTasks(newTasks: Omit<NivrisTask, "id" | "createdAt">[]): void {
        if (!newTasks.length) return;
        const withIds: NivrisTask[] = newTasks.map((t) => ({ ...t, id: nextId(), createdAt: Date.now() }));
        this.tasks = [...this.tasks, ...withIds];
        save(this.tasks);
        this.emit(NIVRIS_TASK_STORE_CHANGE_EVENT);
    }

    public setStatus(id: string, status: NivrisTaskStatus): void {
        this.tasks = this.tasks.map((t) => (t.id === id ? { ...t, status } : t));
        save(this.tasks);
        this.emit(NIVRIS_TASK_STORE_CHANGE_EVENT);
    }

    public removeTask(id: string): void {
        this.tasks = this.tasks.filter((t) => t.id !== id);
        save(this.tasks);
        this.emit(NIVRIS_TASK_STORE_CHANGE_EVENT);
    }
}

export default NivrisTaskStore;
