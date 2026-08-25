/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { getMatrixClient } from "../matrixClient";
import { getMentions, getMessagesSince, searchMessages, type StoredNivrisMessage } from "./NivrisMessageDb";
import { askNivris, NivrisApiError, type NivrisMessage } from "./NivrisApi";
import { type NivrisSettings } from "./types";
import { type NivrisChatMessage, type NivrisUserTracker } from "./NivrisTrackerStore";
import { type NivrisTaskStatus } from "./NivrisTaskStore";
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
    awaitingReply: number;
    /** Messages from others, newer than the tracker's lastSeenTs (i.e. since it was last opened). */
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
    awaitingReply: 0,
    unreadCount: 0,
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
/**
 * `preloaded` lets a caller scoring several trackers in one pass (e.g. NivrisWorkspace's periodic
 * refresh) share a single `getMessagesSince(startOfToday())` read instead of each tracker
 * re-querying IndexedDB independently.
 */
async function findMatches(tracker: NivrisUserTracker, preloaded?: StoredNivrisMessage[]): Promise<StoredNivrisMessage[]> {
    const sinceTs = startOfToday();
    const all = preloaded ?? (await getMessagesSince(sinceTs));

    // Picked from the entity picker (real userId/roomId) — match exactly instead of by fuzzy name.
    if (tracker.targetId && (tracker.type === "boss" || tracker.type === "group")) {
        const field = tracker.type === "boss" ? "sender" : "roomId";
        return all
            .filter((m) => m[field] === tracker.targetId)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, MAX_MATCHES);
    }

    if (tracker.type === "mention") return getMentions(sinceTs, MAX_MATCHES, all);

    const keywords = keywordsForTracker(tracker);
    if (!keywords.length) return [];
    return searchMessages(keywords, sinceTs, MAX_MATCHES, all);
}

export async function computeTrackerMetrics(tracker: NivrisUserTracker, preloaded?: StoredNivrisMessage[]): Promise<TrackerMetrics> {
    const matches = await findMatches(tracker, preloaded);
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

    const lastSeenTs = tracker.lastSeenTs ?? 0;
    const unreadCount = matches.filter((m) => m.ts > lastSeenTs && m.sender !== myUserId).length;

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
    const feedGroups: TrackerFeedGroup[] = Array.from(byRoom.entries())
        .sort((a, b) => Math.max(...b[1].map((m) => m.ts)) - Math.max(...a[1].map((m) => m.ts)))
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

    const systemPrompt = [
        "Bạn là trợ lý N.I.V.R.I.S. đang phân tích các tin nhắn liên quan tới một tracker cụ thể.",
        "Dựa CHỈ trên transcript được cung cấp (không bịa thông tin ngoài transcript), viết tối đa 8 nhận định, mỗi nhận định 1 dòng, không đánh số.",
        "Mỗi nhận định nên cụ thể — nêu rõ ai nói gì, ở phòng nào, và thời điểm nếu liên quan — thay vì chỉ tóm tắt chung chung.",
        "Ưu tiên nêu: các câu hỏi/yêu cầu đang chờ người dùng phản hồi, deadline hoặc mốc thời gian được nhắc tới, việc cần làm (action item) và ai chịu trách nhiệm, các quyết định hoặc thay đổi quan trọng, và bất kỳ mâu thuẫn/vấn đề chưa giải quyết.",
        "Nếu transcript ít nội dung, ít nhận định hơn cũng được — không thêm nhận định thừa để đủ số lượng.",
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

    const systemPrompt = [
        "Bạn là trợ lý N.I.V.R.I.S. đang tóm tắt một thread tin nhắn.",
        "Đọc TOÀN BỘ transcript được cung cấp (không bịa thông tin ngoài transcript) và viết tối đa 8 gạch đầu dòng bằng tiếng Việt, mỗi dòng 1 ý, không đánh số.",
        "Ưu tiên nêu: thread đang bàn về chuyện gì, các quyết định/kết luận đã chốt, việc cần làm và ai chịu trách nhiệm, deadline nếu có, và câu hỏi/việc còn chưa được trả lời.",
        "Nếu transcript ít nội dung, ít gạch đầu dòng hơn cũng được — không thêm ý thừa cho đủ số lượng.",
    ].join("\n");

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

    const systemPrompt = [
        `Bạn là trợ lý N.I.V.R.I.S. đang viết báo cáo cuối ngày cho "${who}" dựa trên tin nhắn của họ hôm nay.`,
        roleLabel
            ? `Lưu ý vai trò/vị trí công việc của người này là "${roleLabel}" khi diễn giải nội dung — báo cáo của quản lý thường là chỉ đạo/quyết định, còn báo cáo của nhân viên thường là tiến độ việc được giao.`
            : "",
        "Dựa CHỈ trên transcript được cung cấp, không bịa thông tin ngoài transcript.",
        "Trả lời theo đúng 3 mục sau, mỗi mục là các gạch đầu dòng ngắn gọn, cụ thể (nêu rõ việc gì, ở phòng nào nếu cần):",
        "",
        ...sections,
        "",
        "Nếu 1 mục không có thông tin trong transcript, ghi 'Không có thông tin' cho mục đó thay vì bỏ trống hoặc bịa ra.",
    ]
        .filter(Boolean)
        .join("\n");

    const messages: NivrisMessage[] = [{ role: "user", content: `Transcript:\n${transcript}` }];

    try {
        return await askNivris(settings, systemPrompt, messages);
    } catch (e) {
        return e instanceof NivrisApiError ? e.message : `Lỗi khi tạo báo cáo: ${e instanceof Error ? e.message : String(e)}`;
    }
}

const TASK_STATUSES: NivrisTaskStatus[] = ["todo", "doing", "done", "late"];

export interface ExtractedTask {
    title: string;
    status: NivrisTaskStatus;
    link?: string;
}

/**
 * Extracts individual task cards for the daily work board from one person's messages today —
 * strict JSON out, so the board can render them as Trello-style cards instead of just prose.
 */
export async function extractTasksForTracker(
    tracker: NivrisUserTracker,
    settings: NivrisSettings,
    matches: StoredNivrisMessage[],
): Promise<ExtractedTask[]> {
    if (!matches.length) return [];

    const employeeMessages = matches.slice(0, MAX_INSIGHT_INPUT_MESSAGES).slice().reverse();

    // Pull in the rest of each thread too (any sender) — a link the task is actually about is
    // often posted by someone else replying in the same thread, not by the employee themselves.
    const threadRootIds = new Set(employeeMessages.map((m) => m.threadRootId).filter((id): id is string => !!id));
    const threadContext: StoredNivrisMessage[] = [];
    if (threadRootIds.size) {
        const sinceTs = startOfToday();
        const all = await getMessagesSince(sinceTs);
        const employeeIds = new Set(employeeMessages.map((m) => m.id));
        for (const m of all) {
            if (m.threadRootId && threadRootIds.has(m.threadRootId) && !employeeIds.has(m.id)) threadContext.push(m);
        }
    }

    const transcript = [...employeeMessages, ...threadContext]
        .sort((a, b) => a.ts - b.ts)
        .map((m) => `[${new Date(m.ts).toLocaleTimeString("vi-VN")}] (${m.roomName}) ${m.senderName}: ${m.body}`)
        .join("\n");

    const systemPrompt = [
        `Trích xuất danh sách công việc CỤ THỂ liên quan tới "${tracker.label}" từ transcript tin nhắn hôm nay bên dưới.`,
        "Transcript có thể gồm cả tin nhắn của người khác trong cùng thread — dùng để hiểu ngữ cảnh và tìm link liên quan, nhưng công việc trích ra vẫn phải là việc của/liên quan tới " +
            tracker.label +
            ".",
        "PHÂN BIỆT RÕ giữa TRAO ĐỔI (không đưa vào) và VIỆC CẦN LÀM (mới đưa vào):",
        "- TRAO ĐỔI: hỏi đáp làm rõ yêu cầu, bàn luận/góp ý, cập nhật tình hình chung, chào hỏi, xác nhận đã hiểu, thảo luận ý tưởng chưa chốt — KHÔNG tạo thẻ cho những tin này.",
        "- VIỆC CẦN LÀM: có một hành động cụ thể được giao/nhận/tự nhận làm (vd 'X làm Y', 'giao cho X việc Y', 'X sẽ Z trước Y giờ'), có deadline được nêu, hoặc một việc được xác nhận đã hoàn thành/bị trễ — CHỈ những tin này mới tạo thẻ.",
        "Nếu không chắc một đoạn hội thoại có phải là 1 việc cụ thể hay chỉ là trao đổi thông thường, hãy coi đó là trao đổi và KHÔNG tạo thẻ — thà bỏ sót còn hơn tạo thẻ rác từ chat phiếm.",
        "Gộp các tin nhắn nói về cùng 1 việc thành 1 đầu việc duy nhất.",
        'Trả về DUY NHẤT một JSON array, không markdown, không giải thích, đúng dạng: [{"title": "...", "status": "todo", "link": "https://..."}, ...]',
        '"title": tên việc ngắn gọn, cụ thể (tối đa ~15 từ).',
        '"status" là một trong: "todo" (mới giao, chưa bắt đầu), "doing" (đang làm/đang thảo luận tiến độ), "done" (đã xác nhận xong), "late" (deadline bị trễ/quá hạn).',
        '"link": URL (Google Docs, Figma, PR, ảnh...) được nhắc tới khi bàn về việc này, do bất kỳ ai gửi trong đoạn hội thoại liên quan. Bỏ field này nếu không có link nào liên quan — không bịa link.',
        "Nếu không có công việc cụ thể nào, trả về mảng rỗng [].",
        "",
        `Transcript:\n${transcript}`,
    ].join("\n");

    const messages: NivrisMessage[] = [{ role: "user", content: "Trích xuất công việc theo đúng định dạng JSON yêu cầu." }];

    let reply: string;
    try {
        reply = await askNivris(settings, systemPrompt, messages);
    } catch {
        return [];
    }

    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    try {
        const parsed = JSON.parse(jsonMatch[0]) as unknown[];
        return parsed
            .filter((item): item is { title: unknown; status: unknown; link?: unknown } => typeof item === "object" && item !== null)
            .map((item) => ({
                title: typeof item.title === "string" ? item.title.trim() : "",
                status: TASK_STATUSES.includes(item.status as NivrisTaskStatus) ? (item.status as NivrisTaskStatus) : "todo",
                link: typeof item.link === "string" && /^https?:\/\//.test(item.link.trim()) ? item.link.trim() : undefined,
            }))
            .filter((t) => t.title.length > 0);
    } catch {
        return [];
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
