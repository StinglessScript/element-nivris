/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { getMatrixClient } from "../matrixClient";
import { getMessagesSince, searchMessages, type StoredNivrisMessage } from "./NivrisMessageDb";
import { askNivris, NivrisApiError, type NivrisMessage } from "./NivrisApi";
import { type NivrisSettings } from "./types";
import { type NivrisUserTracker } from "./NivrisTrackerStore";
import { startOfToday } from "./NivrisIngest";

const PRIORITY_KEYWORDS = ["gấp", "khẩn", "deadline", "ưu tiên", "asap", "urgent", "quan trọng"];
const MAX_MATCHES = 200;
const MAX_ITEMS_PER_ROOM = 15;
const MAX_INSIGHT_INPUT_MESSAGES = 60;

function keywordsForTracker(tracker: NivrisUserTracker): string[] {
    switch (tracker.type) {
        case "boss":
        case "group":
            return [tracker.label.toLowerCase()].filter(Boolean);
        case "mention": {
            const localpart = getMatrixClient().getUserIdLocalpart();
            return localpart ? [localpart.toLowerCase()] : [];
        }
        case "priority":
            return PRIORITY_KEYWORDS;
    }
}

export interface TrackerPriorityItem {
    color: "blue" | "orange" | "violet";
    title: string;
    meta: string;
    message: StoredNivrisMessage;
}

export interface TrackerTeamWeight {
    label: string;
    percent: number;
}

export interface TrackerFeedGroup {
    roomId: string;
    roomName: string;
    color: string;
    items: TrackerPriorityItem[];
}

export interface TrackerMetrics {
    matches: StoredNivrisMessage[];
    total: number;
    roomsCount: number;
    awaitingReply: number;
    lastActivityTs: number | null;
    priorities: TrackerPriorityItem[];
    teamWeights: TrackerTeamWeight[];
    feedGroups: TrackerFeedGroup[];
}

const EMPTY_METRICS: TrackerMetrics = {
    matches: [],
    total: 0,
    roomsCount: 0,
    awaitingReply: 0,
    lastActivityTs: null,
    priorities: [],
    teamWeights: [],
    feedGroups: [],
};

const ROOM_COLORS = ["#0fa3a0", "#c97a22", "#6c5cff", "#2ba95f", "#de3f52"];

function relativeTime(ts: number): string {
    const diffMs = Date.now() - ts;
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "vừa xong";
    if (mins < 60) return `${mins}p trước`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h trước`;
    return `${Math.round(hours / 24)} ngày trước`;
}

const PRIORITY_COLORS: TrackerPriorityItem["color"][] = ["blue", "orange", "violet"];

/**
 * Computes real metrics for a tracker from the local realtime message cache — no network calls,
 * no full-day dump, just a keyword search scoped to this one tracker.
 */
async function findMatches(tracker: NivrisUserTracker): Promise<StoredNivrisMessage[]> {
    // Picked from the entity picker (real userId/roomId) — match exactly instead of by fuzzy name.
    if (tracker.targetId && (tracker.type === "boss" || tracker.type === "group")) {
        const all = await getMessagesSince(0);
        const field = tracker.type === "boss" ? "sender" : "roomId";
        return all
            .filter((m) => m[field] === tracker.targetId)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, MAX_MATCHES);
    }

    const keywords = keywordsForTracker(tracker);
    if (!keywords.length) return [];
    return searchMessages(keywords, MAX_MATCHES);
}

export async function computeTrackerMetrics(tracker: NivrisUserTracker): Promise<TrackerMetrics> {
    const matches = await findMatches(tracker);
    if (!matches.length) return EMPTY_METRICS;

    const myUserId = getMatrixClient().getUserId();
    const roomIds = new Set(matches.map((m) => m.roomId));

    // "Awaiting reply": rooms where the most recent matched message wasn't sent by me.
    const latestByRoom = new Map<string, StoredNivrisMessage>();
    for (const m of matches) {
        const current = latestByRoom.get(m.roomId);
        if (!current || m.ts > current.ts) latestByRoom.set(m.roomId, m);
    }
    const awaitingReply = Array.from(latestByRoom.values()).filter((m) => m.sender !== myUserId).length;

    const recent = [...matches].sort((a, b) => b.ts - a.ts).slice(0, 4);
    const priorities: TrackerPriorityItem[] = recent.map((m, i) => ({
        color: PRIORITY_COLORS[i % PRIORITY_COLORS.length],
        title: `${m.senderName}: ${m.body.length > 60 ? `${m.body.slice(0, 60)}…` : m.body}`,
        meta: `${relativeTime(m.ts)} • ${m.roomName}`,
        message: m,
    }));

    const roomCounts = new Map<string, { name: string; count: number }>();
    for (const m of matches) {
        const entry = roomCounts.get(m.roomId) ?? { name: m.roomName, count: 0 };
        entry.count++;
        roomCounts.set(m.roomId, entry);
    }
    const teamWeights: TrackerTeamWeight[] = Array.from(roomCounts.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map((r) => ({ label: r.name, percent: Math.round((r.count / matches.length) * 100) }));

    // Every matched message, grouped by room so a session with several rooms stays readable —
    // busiest room first, newest message first within each room.
    const byRoom = new Map<string, StoredNivrisMessage[]>();
    for (const m of matches) {
        const list = byRoom.get(m.roomId) ?? [];
        list.push(m);
        byRoom.set(m.roomId, list);
    }
    const feedGroups: TrackerFeedGroup[] = Array.from(byRoom.entries())
        .sort((a, b) => b[1].length - a[1].length)
        .map(([roomId, roomMatches], i) => ({
            roomId,
            roomName: roomMatches[0].roomName,
            color: ROOM_COLORS[i % ROOM_COLORS.length],
            items: [...roomMatches]
                .sort((a, b) => b.ts - a.ts)
                .slice(0, MAX_ITEMS_PER_ROOM)
                .map((m) => ({
                    color: PRIORITY_COLORS[0],
                    title: `${m.senderName}: ${m.body.length > 100 ? `${m.body.slice(0, 100)}…` : m.body}`,
                    meta: relativeTime(m.ts),
                    message: m,
                })),
        }));

    return {
        matches,
        total: matches.length,
        roomsCount: roomIds.size,
        awaitingReply,
        lastActivityTs: recent[0]?.ts ?? null,
        priorities,
        teamWeights,
        feedGroups,
    };
}

/**
 * Asks the configured AI to generate a few short insight bullets for this tracker, based only on
 * the messages this tracker actually matched. User-triggered only (never automatic).
 */
export async function generateTrackerInsights(
    tracker: NivrisUserTracker,
    settings: NivrisSettings,
    matches: StoredNivrisMessage[],
): Promise<string[]> {
    if (!matches.length) return ["Chưa có tin nhắn nào khớp với tracker này trong bộ nhớ đệm."];

    const transcript = matches
        .slice(-MAX_INSIGHT_INPUT_MESSAGES)
        .map((m) => `[${new Date(m.ts).toLocaleString("vi-VN")}] (${m.roomName}) ${m.senderName}: ${m.body}`)
        .join("\n");

    const systemPrompt = [
        "Bạn là trợ lý N.I.V.R.I.S. đang phân tích các tin nhắn liên quan tới một tracker cụ thể.",
        "Dựa CHỈ trên transcript được cung cấp, đưa ra tối đa 4 nhận định ngắn gọn, mỗi nhận định 1 dòng, không đánh số, không giải thích dài dòng.",
        "Không bịa thông tin không có trong transcript.",
    ].join("\n");

    const messages: NivrisMessage[] = [
        { role: "user", content: `Tracker: "${tracker.label || tracker.type}"\n\nTranscript:\n${transcript}` },
    ];

    try {
        const reply = await askNivris(settings, systemPrompt, messages);
        return reply
            .split("\n")
            .map((line) => line.replace(/^[-*•]\s*/, "").trim())
            .filter(Boolean)
            .slice(0, 4);
    } catch (e) {
        return [e instanceof NivrisApiError ? e.message : `Lỗi khi phân tích: ${e instanceof Error ? e.message : String(e)}`];
    }
}

const OVERDUE_MS = 4 * 60 * 60 * 1000;

export interface HomeHourBucket {
    hour: number;
    label: string;
    total: number;
    mentions: number;
}

export interface HomeBusyRoom {
    roomId: string;
    room: string;
    count: number;
}

export interface HomeWaiter {
    senderName: string;
    roomName: string;
    ts: number;
    overdue: boolean;
}

export interface HomeOverview {
    totalToday: number;
    roomsListening: number;
    peakHourLabel: string | null;
    hours: HomeHourBucket[];
    busyRooms: HomeBusyRoom[];
    waiters: HomeWaiter[];
    overdueCount: number;
}

/**
 * Cross-session overview for the Home screen — built from every message ingested today (not just
 * messages matched by a tracker), so it reflects everything Nivris is actually listening to.
 */
export async function computeHomeOverview(): Promise<HomeOverview> {
    const client = getMatrixClient();
    const myUserId = client.getUserId();
    const myLocalpart = client.getUserIdLocalpart()?.toLowerCase();
    const roomsListening = client.getRooms().filter((r) => r.getMyMembership() === "join").length;

    const todayMessages = await getMessagesSince(startOfToday());

    const hourBuckets: HomeHourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        label: String(hour).padStart(2, "0"),
        total: 0,
        mentions: 0,
    }));
    const roomCounts = new Map<string, HomeBusyRoom>();
    const latestByRoom = new Map<string, StoredNivrisMessage>();

    for (const m of todayMessages) {
        const hour = new Date(m.ts).getHours();
        hourBuckets[hour].total++;
        if (myLocalpart && m.body.toLowerCase().includes(myLocalpart)) hourBuckets[hour].mentions++;

        const room = roomCounts.get(m.roomId) ?? { roomId: m.roomId, room: m.roomName, count: 0 };
        room.count++;
        roomCounts.set(m.roomId, room);

        const current = latestByRoom.get(m.roomId);
        if (!current || m.ts > current.ts) latestByRoom.set(m.roomId, m);
    }

    const peak = hourBuckets.reduce((best, h) => (h.total > best.total ? h : best), hourBuckets[0]);

    const waiters: HomeWaiter[] = Array.from(latestByRoom.values())
        .filter((m) => m.sender !== myUserId)
        .sort((a, b) => a.ts - b.ts)
        .map((m) => ({
            senderName: m.senderName,
            roomName: m.roomName,
            ts: m.ts,
            overdue: Date.now() - m.ts > OVERDUE_MS,
        }));

    return {
        totalToday: todayMessages.length,
        roomsListening,
        peakHourLabel: peak.total > 0 ? `${peak.label}:00–${String((peak.hour + 1) % 24).padStart(2, "0")}:00` : null,
        hours: hourBuckets,
        busyRooms: Array.from(roomCounts.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 5),
        waiters: waiters.slice(0, 6),
        overdueCount: waiters.filter((w) => w.overdue).length,
    };
}
