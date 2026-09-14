/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { getDirectRoomIds, getMatrixClient } from "../matrixClient";
import { getMentions, getMessageById, getMessagesSince, searchMessages, type StoredNivrisMessage } from "./NivrisMessageDb";
import { askNivris, NivrisApiError, type NivrisMessage } from "./NivrisApi";
import { type NivrisSettings } from "./types";
import NivrisDoneStore from "./NivrisDoneStore";
import { buildSystemPrompt } from "./outputTemplates";
import { type NivrisChatMessage, type NivrisUserTracker } from "./NivrisTrackerStore";
import { startOfToday } from "./NivrisIngest";
import { JOB_TITLE_OPTIONS, PRIORITY_KEYWORDS } from "./constants";

const MAX_MATCHES = 200;
const MAX_ITEMS_PER_ROOM = 15;
const MAX_INSIGHT_INPUT_MESSAGES = 120;

function keywordsForTracker(tracker: NivrisUserTracker): string[] {
    switch (tracker.type) {
        case "boss":
        case "group":
            return [tracker.label.toLowerCase()].filter(Boolean);
        case "mention":
            // Handled separately in findMatches via getMentions() — not keyword-based.
            return [];
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
    /** Messages from others not yet marked "đã xem" — the same set the Chưa xem filter shows. */
    unreadCount: number;
    lastActivityTs: number | null;
    priorities: TrackerPriorityItem[];
    teamWeights: TrackerTeamWeight[];
    feedGroups: TrackerFeedGroup[];
}

const EMPTY_METRICS: TrackerMetrics = {
    matches: [],
    total: 0,
    roomsCount: 0,
    unreadCount: 0,
    lastActivityTs: null,
    priorities: [],
    teamWeights: [],
    feedGroups: [],
};

// Element's own decorative ramp — the same six hues it tints usernames and avatars with — so a
// room reads in the same colour here as it does in the timeline instead of in a private palette.
const ROOM_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `var(--cpd-color-text-decorative-${n})`);

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
/**
 * `preloaded` lets a caller scoring several trackers in one pass (e.g. NivrisWorkspace's periodic
 * refresh) share a single `getMessagesSince(startOfToday())` read instead of each tracker
 * re-querying IndexedDB independently.
 */
async function findMatches(tracker: NivrisUserTracker, preloaded?: StoredNivrisMessage[]): Promise<StoredNivrisMessage[]> {
    const sinceTs = startOfToday();
    // Private messages are never tracked — a tracker is about work happening in rooms, and a DM
    // showing up under "Sếp" or "Ưu tiên" is both noise and not something the user asked to watch.
    const directRoomIds = getDirectRoomIds();
    const all = (preloaded ?? (await getMessagesSince(sinceTs))).filter((m) => !directRoomIds.has(m.roomId));

    // Matching is done unbounded and capped afterwards, so the count reported to the UI is the real
    // one. Capping first made a session with 350 messages report "200 tin" — a number that says more
    // about MAX_MATCHES than about the person.
    if (tracker.targetId && (tracker.type === "boss" || tracker.type === "group")) {
        const field = tracker.type === "boss" ? "sender" : "roomId";
        return all.filter((m) => m[field] === tracker.targetId).sort((a, b) => b.ts - a.ts);
    }

    if (tracker.type === "mention") return getMentions(sinceTs, Number.MAX_SAFE_INTEGER, all);

    const keywords = keywordsForTracker(tracker);
    if (!keywords.length) return [];
    return searchMessages(keywords, sinceTs, Number.MAX_SAFE_INTEGER, all);
}

/**
 * Matching for an explicit set of messages rather than "today" — the report screen uses it to
 * build (or rebuild) a report for any day still held in the local cache, using exactly the same
 * matching rules the live metrics use.
 */
export async function matchesInMessages(
    tracker: NivrisUserTracker,
    messages: StoredNivrisMessage[],
): Promise<StoredNivrisMessage[]> {
    return findMatches(tracker, messages);
}

export async function computeTrackerMetrics(tracker: NivrisUserTracker, preloaded?: StoredNivrisMessage[]): Promise<TrackerMetrics> {
    const allMatches = await findMatches(tracker, preloaded);
    if (!allMatches.length) return EMPTY_METRICS;
    // Counts come from every match; everything that renders or gets sent to the AI works off the
    // capped list, which is what MAX_MATCHES is actually for.
    const total = allMatches.length;
    const matches = allMatches.slice(0, MAX_MATCHES);

    const myUserId = getMatrixClient().getUserId();
    const roomIds = new Set(allMatches.map((m) => m.roomId));

    // Counted off the "đã xem" marks, not a lastSeenTs stamp. There were two different notions of
    // unread in the app: the badge used "anything since you last clicked this session", while the
    // Chưa xem / Đã xem filter right above the feed used the per-message marks. Opening a session
    // silently zeroed the first one, so a feed listing four unseen messages sat under a session with
    // no badge — reported live. The marks are the one the user actually drives, so the badge follows
    // them, and "Đã xem tất cả" clears it exactly as it reads.
    const doneIds = NivrisDoneStore.instance.getAll();
    const unreadCount = allMatches.filter((m) => m.sender !== myUserId && !doneIds.has(m.id)).length;

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
    // most recently active room first, newest message first within each room.
    const byRoom = new Map<string, StoredNivrisMessage[]>();
    for (const m of matches) {
        const list = byRoom.get(m.roomId) ?? [];
        list.push(m);
        byRoom.set(m.roomId, list);
    }

    // The room name is only worth repeating on every row when there's no room tab strip above to
    // convey it — with 2+ rooms, the currently-selected tab already says which room, and restating
    // it on every single row was pure noise (reported live).
    const showRoomName = byRoom.size <= 1;
    const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

    // "trong thread" alone doesn't say *which* thread — show the thread's own first message as a
    // short preview instead, so you can tell threads apart without opening each one. Root ids are
    // deduped and fetched once (not per-message) since several matches commonly share one thread.
    // Grouping/collapsing several replies into one row was tried and reverted (reported live as
    // "rối mắt" — visually cluttered): flat, one row per message, with the thread label on each,
    // is what stuck.
    const threadRootIds = Array.from(new Set(matches.map((m) => m.threadRootId).filter((id): id is string => !!id)));
    // Only .body is ever read off an entry — a minimal shape so the network-fallback path below
    // doesn't need to fabricate a full StoredNivrisMessage for something that was never ingested.
    const threadRoots = new Map<string, { body: string }>();
    if (threadRootIds.length) {
        const roots = await Promise.all(threadRootIds.map((id) => getMessageById(id)));
        const missing: string[] = [];
        roots.forEach((root, i) => {
            if (root) threadRoots.set(threadRootIds[i], root);
            else missing.push(threadRootIds[i]);
        });
        // Two DIFFERENT messages both showing "Thread: <themselves>" — reported live, confirmed to
        // actually be the same real thread — traced to this: the thread's root can legitimately be
        // missing from the local cache (started before Nivris was ingesting, or older than backfill
        // reaches), and every message referencing it independently fell back to displaying its own
        // body as if it were the root, which looks exactly like a wrong/self-referencing thread even
        // though the underlying threadRootId was correct and shared all along. Fetch the actual root
        // over the network instead of guessing when the local cache doesn't have it.
        if (missing.length) {
            const roomIdByRoot = new Map<string, string>();
            for (const m of matches) {
                if (m.threadRootId && missing.includes(m.threadRootId)) roomIdByRoot.set(m.threadRootId, m.roomId);
            }
            const client = getMatrixClient();
            await Promise.all(
                missing.map(async (id) => {
                    const roomId = roomIdByRoot.get(id);
                    if (!roomId) return;
                    try {
                        const raw = (await client.fetchRoomEvent(roomId, id)) as { content?: { body?: unknown } } | undefined;
                        const body = typeof raw?.content?.body === "string" ? raw.content.body : "";
                        if (body) threadRoots.set(id, { body });
                    } catch {
                        // offline, redacted, no access to the event, etc. — leave unset, buildItem
                        // falls back to the message's own body same as before this existed
                    }
                }),
            );
        }
    }

    function buildItem(m: StoredNivrisMessage): TrackerPriorityItem {
        const roomSuffix = showRoomName ? ` • ${m.roomName}` : "";
        const threadSuffix = m.threadRootId ? ` • Thread: "${truncate((threadRoots.get(m.threadRootId) ?? m).body, 40)}"` : "";
        return {
            color: PRIORITY_COLORS[0],
            title: `${m.senderName}: ${truncate(m.body, 100)}`,
            meta: `${relativeTime(m.ts)}${roomSuffix}${threadSuffix}`,
            message: m,
        };
    }

    const feedGroups: TrackerFeedGroup[] = Array.from(byRoom.entries())
        .sort((a, b) => Math.max(...b[1].map((m) => m.ts)) - Math.max(...a[1].map((m) => m.ts)))
        .map(([roomId, roomMatches], i) => ({
            roomId,
            roomName: roomMatches[0].roomName,
            color: ROOM_COLORS[i % ROOM_COLORS.length],
            items: [...roomMatches]
                .sort((a, b) => b.ts - a.ts)
                .slice(0, MAX_ITEMS_PER_ROOM)
                .map(buildItem),
        }));

    return {
        matches,
        total,
        roomsCount: roomIds.size,
        unreadCount,
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

    // matches is newest-first; take the most recent N, then present chronologically for the AI.
    const transcript = matches
        .slice(0, MAX_INSIGHT_INPUT_MESSAGES)
        .slice()
        .reverse()
        .map((m) => `[${new Date(m.ts).toLocaleString("vi-VN")}] (${m.roomName}) ${m.senderName}: ${m.body}`)
        .join("\n");

    const systemPrompt = buildSystemPrompt(settings, "insights", { tracker: `"${tracker.label || tracker.type}"` });

    const messages: NivrisMessage[] = [
        { role: "user", content: `Tracker: "${tracker.label || tracker.type}"\n\nTranscript:\n${transcript}` },
    ];

    try {
        const reply = await askNivris(settings, systemPrompt, messages);
        return reply
            .split("\n")
            .map((line) => line.replace(/^[-*•]\s*/, "").trim())
            .filter(Boolean)
            .slice(0, 8);
    } catch (e) {
        return [e instanceof NivrisApiError ? e.message : `Lỗi khi phân tích: ${e instanceof Error ? e.message : String(e)}`];
    }
}

/**
 * Summarizes a single thread (root message + all replies), grounded only in that thread's
 * messages — no keyword matching involved, the caller already knows exactly which messages
 * belong to the thread (see getMessagesByThreadRoot).
 */
export async function summarizeThread(settings: NivrisSettings, threadMessages: StoredNivrisMessage[]): Promise<string[]> {
    if (!threadMessages.length) return ["Không có tin nhắn nào trong thread này."];

    const transcript = threadMessages
        .map((m) => `[${new Date(m.ts).toLocaleString("vi-VN")}] ${m.senderName}: ${m.body}`)
        .join("\n");

    const systemPrompt = buildSystemPrompt(settings, "thread");

    const messages: NivrisMessage[] = [{ role: "user", content: `Transcript:\n${transcript}` }];

    try {
        const reply = await askNivris(settings, systemPrompt, messages);
        return reply
            .split("\n")
            .map((line) => line.replace(/^[-*•]\s*/, "").trim())
            .filter(Boolean)
            .slice(0, 8);
    } catch (e) {
        return [e instanceof NivrisApiError ? e.message : `Lỗi khi tóm tắt: ${e instanceof Error ? e.message : String(e)}`];
    }
}

const MAX_CHAT_HISTORY_TURNS = 20;

/**
 * Answers a free-form question about this tracker, grounded in its matched messages plus the
 * running chat history (so follow-up questions have context). Same transcript-building approach
 * as generateTrackerInsights, but conversational instead of a one-shot bullet summary.
 */
export async function askTrackerQuestion(
    tracker: NivrisUserTracker,
    settings: NivrisSettings,
    matches: StoredNivrisMessage[],
    priorChat: NivrisChatMessage[],
    question: string,
): Promise<string> {
    const transcript = matches.length
        ? matches
              .slice(0, MAX_INSIGHT_INPUT_MESSAGES)
              .slice()
              .reverse()
              .map((m) => `[${new Date(m.ts).toLocaleString("vi-VN")}] (${m.roomName}) ${m.senderName}: ${m.body}`)
              .join("\n")
        : "(chưa có tin nhắn nào khớp với tracker này trong bộ nhớ đệm)";

    const systemPrompt = [
        `Bạn là trợ lý N.I.V.R.I.S. đang trò chuyện với người dùng về tracker "${tracker.label || tracker.type}".`,
        "Trả lời dựa trên transcript tin nhắn bên dưới. Nếu câu hỏi cần thông tin không có trong transcript, nói rõ là không có đủ dữ liệu — không bịa.",
        "Trả lời ngắn gọn, tự nhiên bằng tiếng Việt, như đang nhắn tin, không cần mở đầu/kết luận rườm rà.",
        `Transcript:\n${transcript}`,
    ].join("\n\n");

    const messages: NivrisMessage[] = [
        ...priorChat.slice(-MAX_CHAT_HISTORY_TURNS).map((m): NivrisMessage => ({ role: m.role, content: m.content })),
        { role: "user", content: question },
    ];

    try {
        return await askNivris(settings, systemPrompt, messages);
    } catch (e) {
        return e instanceof NivrisApiError ? e.message : `Lỗi: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/**
 * Generates an end-of-day report for one employee (a "boss"-type tracker tagged isEmployee),
 * grounded in that person's messages for today. Structured into 3 sections so it reads like a
 * standup update: what they worked on, what's done, what's late/still open.
 */
export async function generateDailyReport(
    tracker: NivrisUserTracker,
    settings: NivrisSettings,
    matches: StoredNivrisMessage[],
): Promise<string> {
    if (!matches.length) return "Không có tin nhắn nào hôm nay để tổng hợp báo cáo.";

    const transcript = matches
        .slice(0, MAX_INSIGHT_INPUT_MESSAGES)
        .slice()
        .reverse()
        .map((m) => `[${new Date(m.ts).toLocaleTimeString("vi-VN")}] (${m.roomName}) ${m.senderName}: ${m.body}`)
        .join("\n");

    const roleLabel = JOB_TITLE_OPTIONS.find((o) => o.value === tracker.jobTitle)?.label;
    const who = roleLabel ? `${tracker.label} (${roleLabel})` : tracker.label;
    const isManager = tracker.jobTitle === "manager" || tracker.jobTitle === "executive";

    const sections = isManager
        ? [
              "ĐÃ CHỈ ĐẠO / QUYẾT ĐỊNH TRONG NGÀY:",
              "(việc giao cho ai, quyết định gì được chốt)",
              "",
              "TÌNH HÌNH ĐỘI NHÓM:",
              "(ai đang làm gì, ai đang bị chặn/chờ gì)",
              "",
              "VIỆC CẦN THEO DÕI TIẾP:",
              "(việc chưa chốt, câu hỏi chưa có câu trả lời — nếu không có gì thì ghi 'Không có việc cần theo dõi thêm')",
          ]
        : [
              "ĐÃ LÀM HÔM NAY:",
              "(những việc/thảo luận/quyết định trong ngày)",
              "",
              "ĐÃ XONG:",
              "(việc được xác nhận hoàn thành, chốt xong)",
              "",
              "TRỄ / CHƯA XONG:",
              "(deadline bị trễ, việc còn đang chờ, câu hỏi chưa được trả lời — nếu không có gì trễ thì ghi 'Không có việc trễ')",
          ];

    // {{role}} is deliberately left undefined when the person has no job title — fillTemplate then
    // drops that whole line rather than telling the model their role is "undefined".
    const systemPrompt = buildSystemPrompt(settings, "report", {
        who: `"${who}"`,
        role: roleLabel ? `"${roleLabel}"` : undefined,
        sections: sections.join("\n"),
    });

    const messages: NivrisMessage[] = [{ role: "user", content: `Transcript:\n${transcript}` }];

    try {
        return await askNivris(settings, systemPrompt, messages);
    } catch (e) {
        return e instanceof NivrisApiError ? e.message : `Lỗi khi tạo báo cáo: ${e instanceof Error ? e.message : String(e)}`;
    }
}

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


export interface HomeOverview {
    totalToday: number;
    roomsListening: number;
    peakHourLabel: string | null;
    hours: HomeHourBucket[];
    busyRooms: HomeBusyRoom[];
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

    return {
        totalToday: todayMessages.length,
        roomsListening,
        peakHourLabel: peak.total > 0 ? `${peak.label}:00–${String((peak.hour + 1) % 24).padStart(2, "0")}:00` : null,
        hours: hourBuckets,
        busyRooms: Array.from(roomCounts.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 5),
    };
}
