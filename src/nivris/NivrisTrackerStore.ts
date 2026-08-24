/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { EventEmitter } from "events";

export const NIVRIS_TRACKER_STORE_CHANGE_EVENT = "change";

export type NivrisTrackerType = "boss" | "group" | "mention" | "priority";

export interface NivrisUserTracker {
    id: string;
    type: NivrisTrackerType;
    /** Display label — the person/room name for "boss"/"group", fixed text for "mention"/"priority". */
    label: string;
    /**
     * For "boss"/"group" trackers created by picking a real person/room (not typed free text): the
     * exact userId or roomId, so metrics match precisely instead of via a fuzzy name search.
     */
    targetId?: string;
    createdAt: number;
    /** Cached AI-generated insights for this tracker, filled in on demand (not automatically). */
    insights?: string[];
    insightsGeneratedAt?: number;
    /** Free-form Q&A chat about this tracker's messages, persisted per-tracker like insights. */
    chatMessages?: NivrisChatMessage[];
    /** Timestamp of the last time this tracker's feed was viewed — messages newer than this count
     * as unread. Updated whenever the tracker becomes the active session. */
    lastSeenTs?: number;
}

export interface NivrisChatMessage {
    role: "user" | "assistant";
    content: string;
    ts: number;
}

const STORAGE_KEY = "mx_nivris_trackers";

let idCounter = 0;
function nextId(): string {
    idCounter++;
    return `nivris-tracker-${Date.now()}-${idCounter}`;
}

function load(): NivrisUserTracker[] {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as NivrisUserTracker[]) : [];
    } catch {
        return [];
    }
}

function save(trackers: NivrisUserTracker[]): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trackers));
}

/**
 * Holds the user's self-created trackers (there are none by default — the user adds them via the
 * workspace composer) plus which one is currently selected. Persisted locally so trackers survive
 * reloads, same as chat/UI-open state persist across the session via the other Nivris stores.
 */
class NivrisTrackerStore extends EventEmitter {
    private static internalInstance: NivrisTrackerStore;

    private trackers: NivrisUserTracker[] = load();
    // Always land on Home when the workspace opens — don't auto-restore the last selected session.
    private activeId: string | null = null;

    private constructor() {
        super();
    }

    public static get instance(): NivrisTrackerStore {
        if (!NivrisTrackerStore.internalInstance) {
            NivrisTrackerStore.internalInstance = new NivrisTrackerStore();
        }
        return NivrisTrackerStore.internalInstance;
    }

    public getTrackers(): NivrisUserTracker[] {
        return this.trackers;
    }

    public getActiveId(): string | null {
        return this.activeId;
    }

    public getActive(): NivrisUserTracker | null {
        return this.trackers.find((t) => t.id === this.activeId) ?? null;
    }

    public setActive(id: string | null): void {
        if (this.activeId === id) return;
        this.activeId = id;
        if (id) {
            this.trackers = this.trackers.map((t) => (t.id === id ? { ...t, lastSeenTs: Date.now() } : t));
            save(this.trackers);
        }
        this.emit(NIVRIS_TRACKER_STORE_CHANGE_EVENT);
    }

    /** Singleton trackers (mention/priority) return the existing one instead of duplicating. */
    public addTracker(type: NivrisTrackerType, label: string, targetId?: string): NivrisUserTracker {
        if (type === "mention" || type === "priority") {
            const existing = this.trackers.find((t) => t.type === type);
            if (existing) {
                this.setActive(existing.id);
                return existing;
            }
        }

        const tracker: NivrisUserTracker = { id: nextId(), type, label: label.trim(), targetId, createdAt: Date.now() };
        this.trackers = [...this.trackers, tracker];
        this.activeId = tracker.id;
        save(this.trackers);
        this.emit(NIVRIS_TRACKER_STORE_CHANGE_EVENT);
        return tracker;
    }

    public removeTracker(id: string): void {
        this.trackers = this.trackers.filter((t) => t.id !== id);
        if (this.activeId === id) {
            this.activeId = this.trackers[0]?.id ?? null;
        }
        save(this.trackers);
        this.emit(NIVRIS_TRACKER_STORE_CHANGE_EVENT);
    }

    public setInsights(id: string, insights: string[]): void {
        this.trackers = this.trackers.map((t) => (t.id === id ? { ...t, insights, insightsGeneratedAt: Date.now() } : t));
        save(this.trackers);
        this.emit(NIVRIS_TRACKER_STORE_CHANGE_EVENT);
    }

    public appendChatMessages(id: string, newMessages: NivrisChatMessage[]): void {
        this.trackers = this.trackers.map((t) =>
            t.id === id ? { ...t, chatMessages: [...(t.chatMessages ?? []), ...newMessages] } : t,
        );
        save(this.trackers);
        this.emit(NIVRIS_TRACKER_STORE_CHANGE_EVENT);
    }

    public clearChat(id: string): void {
        this.trackers = this.trackers.map((t) => (t.id === id ? { ...t, chatMessages: [] } : t));
        save(this.trackers);
        this.emit(NIVRIS_TRACKER_STORE_CHANGE_EVENT);
    }
}

export default NivrisTrackerStore;
