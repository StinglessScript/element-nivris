/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { getMatrixClient } from "../matrixClient";
import { getMentions, getMessagesSince, type StoredNivrisMessage } from "./NivrisMessageDb";
import { askNivris, NivrisApiError, type NivrisMessage } from "./NivrisApi";
import { type NivrisSettings, isNivrisConfigured } from "./types";
import { startOfToday } from "./NivrisIngest";
import { computeHomeOverview } from "./computeTrackerInsights";
import NivrisTrackerStore from "./NivrisTrackerStore";

/**
 * The global assistant — a plain chat over EVERYTHING Nivris has ingested, as opposed to
 * SessionInspector's chat which is scoped to one tracker's matches. Meant for the case where the
 * user doesn't know (or care) which session/room something belongs to: "tin nhắn đó ở đâu ấy nhỉ",
 * "hôm nay có gì cần tôi trả lời", "tóm tắt phòng X", "soạn giúp câu trả lời".
 *
 * Two AI calls per question: a cheap planning call that turns the question into a retrieval plan,
 * then the answering call over exactly the slice of cache that plan asked for. Retrieval is planned
 * rather than "send everything" because the cache holds a week of every room — far past what fits
 * in a prompt, and mostly irrelevant to any single question.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type AssistantRange = "today" | "3d" | "7d" | "all";

function rangeSinceTs(range: AssistantRange): number {
    switch (range) {
        case "today":
            return startOfToday();
        case "3d":
            return startOfToday() - 2 * DAY_MS;
        case "7d":
            return startOfToday() - 6 * DAY_MS;
        case "all":
            // Everything IndexedDB still holds. Nominally a 7-day window (NivrisIngest's
            // RETENTION_DAYS prune), but asking for 0 rather than computing that cutoff here means
            // "tìm tất cả" keeps meaning all of it if retention is ever widened.
            return 0;
    }
}

const RANGE_LABEL: Record<AssistantRange, string> = {
    today: "hôm nay",
    "3d": "3 ngày gần đây",
    "7d": "7 ngày gần đây",
    all: "toàn bộ bộ nhớ đệm",
};

/**
 * Diacritic-insensitive folding, so "hop dong" finds "hợp đồng" — people typing a half-remembered
 * phrase in a hurry rarely bother with dấu, and an exact-match-only search would just come back
 * empty for them.
 */
function fold(s: string): string {
    return s
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase();
}

// Words carrying no signal for retrieval — they'd match nearly every message and drown the score.
const STOPWORDS = new Set(
    [
        "toi", "minh", "ban", "anh", "chi", "em", "la", "co", "khong", "duoc", "cua", "va", "voi",
        "cho", "de", "nao", "gi", "the", "nay", "kia", "ay", "do", "hom", "qua", "vua", "roi",
        "ai", "o", "dau", "khi", "luc", "ma", "thi", "nhu", "ve", "tin", "nhan", "tim", "giup",
        "nho", "quen", "xem", "lai", "mot", "cai", "trong", "tren", "duoi", "nhung", "cung",
        "hay", "hoac", "boi", "vi", "sao", "bao", "gio", "san", "nhi", "a", "u", "oi", "day",
        "nhe", "nha", "di", "dang", "se", "da", "van", "con", "them", "moi", "rat", "lam",
        "phai", "muon", "can", "tom", "tat", "hoi", "noi",
    ].map(fold),
);

/** Content words from a free-form question, used to widen (or stand in for) the AI's own keywords. */
function keywordsFromQuestion(question: string): string[] {
    const words = fold(question)
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
    return Array.from(new Set(words));
}

/** What the planning call decided this question needs pulled out of the cache. */
type AssistantNeed = "search" | "recent" | "overview" | "mentions";

const ALL_NEEDS: AssistantNeed[] = ["search", "recent", "overview", "mentions"];

interface RetrievalPlan {
    keywords: string[];
    senders: string[];
    rooms: string[];
    range: AssistantRange;
    needs: AssistantNeed[];
}

const DEFAULT_PLAN: RetrievalPlan = { keywords: [], senders: [], rooms: [], range: "today", needs: ["search", "recent"] };

async function planRetrieval(settings: NivrisSettings, question: string, priorChat: AssistantChatMessage[]): Promise<RetrievalPlan> {
    const systemPrompt = [
        "Bạn là bộ phận lập kế hoạch tra cứu của một trợ lý chat nội bộ. Người dùng hỏi một câu; nhiệm vụ của bạn KHÔNG phải trả lời, mà là quyết định cần lấy dữ liệu gì từ kho tin nhắn để trả lời được.",
        'Trả về DUY NHẤT một JSON object, không markdown, không giải thích, đúng dạng: {"keywords": ["..."], "senders": ["..."], "rooms": ["..."], "range": "today", "needs": ["search"]}',
        '"keywords": từ/cụm từ NỘI DUNG có thể xuất hiện trong chính tin nhắn cần tìm, kèm cách viết khác/từ đồng nghĩa/viết tắt hay dùng trong chat công việc tiếng Việt (vd "hợp đồng" → "hđ", "contract"). Tối đa 12 mục, mỗi mục 1-3 từ. Để mảng rỗng nếu câu hỏi không nhắm vào một chủ đề cụ thể (vd "hôm nay có gì mới").',
        '"senders": tên người được nhắc tới trong câu hỏi. "rooms": tên phòng/nhóm được nhắc tới. Không bịa tên không có trong câu hỏi.',
        '"range": khoảng thời gian cần tra — "today" (hôm nay), "3d" (3 ngày gần đây), "7d" (7 ngày), "all" (TẤT CẢ tin nhắn còn trong bộ nhớ đệm). Chọn rộng hơn nếu câu hỏi nhắc tới hôm qua/tuần này/lâu rồi; chọn "all" khi người dùng nói "tìm tất cả", "từ trước tới giờ", "lâu rồi", hoặc khi họ không nhớ nổi chuyện đó xảy ra khi nào.',
        '"needs": chọn các mục cần thiết trong: "search" (tìm tin theo từ khoá/người/phòng), "recent" (các tin mới nhất mọi phòng), "overview" (thống kê tổng quan: số tin, phòng sôi động, ai đang chờ trả lời), "mentions" (các tin nhắc tên người dùng).',
        "Ví dụ: hỏi tìm lại một tin cũ → needs [\"search\"]. Hỏi hôm nay có gì / cần làm gì → [\"recent\",\"overview\",\"mentions\"]. Hỏi ai đang chờ mình → [\"overview\",\"mentions\"]. Hỏi về công việc của một người → [\"search\",\"recent\"].",
    ].join("\n");

    // The last couple of turns go in so follow-ups ("còn tin nào khác không?") get planned against
    // what was actually being discussed, not read as a brand-new topic-less question.
    const context = priorChat
        .slice(-2)
        .map((m) => `${m.role === "user" ? "Người dùng" : "Trợ lý"}: ${m.content.slice(0, 400)}`)
        .join("\n");

    let reply: string;
    try {
        reply = await askNivris(settings, systemPrompt, [
            { role: "user", content: context ? `Ngữ cảnh trước đó:\n${context}\n\nCâu hỏi mới: ${question}` : question },
        ]);
    } catch {
        return DEFAULT_PLAN;
    }

    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return DEFAULT_PLAN;
    try {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        const asList = (v: unknown): string[] =>
            Array.isArray(v)
                ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 12)
                : [];
        const range =
            parsed.range === "3d" || parsed.range === "7d" || parsed.range === "all" ? parsed.range : "today";
        const needs = asList(parsed.needs).filter((n): n is AssistantNeed => (ALL_NEEDS as string[]).includes(n));
        return {
            keywords: asList(parsed.keywords),
            senders: asList(parsed.senders),
            rooms: asList(parsed.rooms),
            range,
            needs: needs.length ? needs : DEFAULT_PLAN.needs,
        };
    } catch {
        return DEFAULT_PLAN;
    }
}

/**
 * Ranked keyword search over the whole cache. Scored rather than merely filtered (what
 * NivrisMessageDb.searchMessages does) because a recall question fans out into a dozen loose
 * keywords — with a plain OR filter the one message matching every term would be buried under
 * hundreds matching a single common word.
 */
function rankMessages(messages: StoredNivrisMessage[], plan: RetrievalPlan): StoredNivrisMessage[] {
    const keywords = Array.from(new Set(plan.keywords.map(fold).filter(Boolean)));
    const senders = plan.senders.map(fold).filter(Boolean);
    const rooms = plan.rooms.map(fold).filter(Boolean);
    if (!keywords.length && !senders.length && !rooms.length) return [];

    const newest = messages.reduce((max, m) => Math.max(max, m.ts), 0) || Date.now();

    const scored: { message: StoredNivrisMessage; score: number }[] = [];
    for (const m of messages) {
        const body = fold(m.body);
        const roomName = fold(m.roomName);
        const senderName = fold(m.senderName);

        let score = 0;
        for (const k of keywords) {
            if (body.includes(k)) score += 3;
            else if (roomName.includes(k) || senderName.includes(k)) score += 1;
        }
        for (const s of senders) if (senderName.includes(s)) score += 4;
        for (const r of rooms) if (roomName.includes(r)) score += 4;
        if (!score) continue;

        // Small recency nudge (<1 point) so equally-relevant hits surface newest-first without ever
        // outranking a genuinely better keyword match.
        score += Math.max(0, 1 - (newest - m.ts) / (7 * DAY_MS)) * 0.9;
        scored.push({ message: m, score });
    }

    scored.sort((a, b) => b.score - a.score || b.message.ts - a.message.ts);
    return scored.map((c) => c.message);
}

export interface AssistantChatMessage {
    role: "user" | "assistant";
    content: string;
    ts: number;
    /** Messages the answer cited, resolved back to real cached messages so they stay clickable. */
    cited?: StoredNivrisMessage[];
    /** How many cached messages this answer was grounded in. */
    usedCount?: number;
    /** Every message the keyword pass matched, best first — the "xem tất cả" list under the reply. */
    matches?: StoredNivrisMessage[];
    /** Total matches found, which can exceed the (capped) `matches` list actually kept. */
    matchTotal?: number;
    /** Time window actually searched, so the reply can say so. */
    range?: AssistantRange;
}

export interface AssistantResult {
    answer: string;
    cited: StoredNivrisMessage[];
    /** How many cached messages the answer was grounded in — shown under the reply. */
    usedCount: number;
    matches: StoredNivrisMessage[];
    matchTotal: number;
    range: AssistantRange;
}

const MAX_CHAT_HISTORY_TURNS = 12;
const MAX_SEARCH_MESSAGES = 45;
const MAX_RECENT_MESSAGES = 35;
const MAX_CONTEXT_MESSAGES = 70;
/** Cap on the full match list handed back to the UI (and so written to localStorage per turn). */
const MAX_RETURNED_MATCHES = 120;

function formatMessageLine(m: StoredNivrisMessage, index: number): string {
    return `[#${index}] [${new Date(m.ts).toLocaleString("vi-VN")}] (${m.roomName}) ${m.senderName}: ${m.body}`;
}

/** The non-message context blocks (stats, mentions, sessions) the plan asked for. */
async function buildSideContext(plan: RetrievalPlan, todayMessages: StoredNivrisMessage[]): Promise<string[]> {
    const blocks: string[] = [];

    if (plan.needs.includes("overview")) {
        const overview = await computeHomeOverview();
        blocks.push(
            [
                "TỔNG QUAN HÔM NAY:",
                `- ${overview.totalToday} tin trong ${overview.roomsListening} phòng đang nghe${overview.peakHourLabel ? `, cao điểm ${overview.peakHourLabel}` : ""}`,
                `- Phòng sôi động: ${overview.busyRooms.map((r) => `${r.room} (${r.count})`).join(", ") || "không có"}`,
                `- Đang chờ bạn trả lời: ${overview.waiters.map((w) => `${w.senderName} ở ${w.roomName}${w.overdue ? " (quá 4h)" : ""}`).join("; ") || "không ai"}`,
            ].join("\n"),
        );
    }

    if (plan.needs.includes("mentions")) {
        const mentions = await getMentions(startOfToday(), 20, todayMessages);
        blocks.push(
            `TIN NHẮC TÊN BẠN HÔM NAY (${mentions.length}):\n` +
                (mentions.map((m) => `- (${m.roomName}) ${m.senderName}: ${m.body.slice(0, 160)}`).join("\n") || "- không có"),
        );
    }

    const trackers = NivrisTrackerStore.instance.getTrackers();
    if (trackers.length) {
        blocks.push(`CÁC SESSION ĐANG THEO DÕI: ${trackers.map((t) => `${t.label || t.type} (${t.type})`).join(", ")}`);
    }

    return blocks;
}

/**
 * Answers a free-form question about everything in the cache, and hands back the actual messages
 * behind the answer so the user can jump straight to one in Element. Grounded strictly in what was
 * retrieved — an answer that can't be traced to a real cached message is worse than useless here.
 */
export async function askAssistant(
    settings: NivrisSettings,
    question: string,
    priorChat: AssistantChatMessage[],
): Promise<AssistantResult> {
    if (!isNivrisConfigured(settings)) {
        return {
            answer: "Chưa cấu hình AI — cần model, base URL và API key trong Cài đặt trước khi trò chuyện được.",
            cited: [],
            usedCount: 0,
            matches: [],
            matchTotal: 0,
            range: "today",
        };
    }

    const plan = await planRetrieval(settings, question, priorChat);
    // The question's own content words always go in too — the AI's paraphrases can miss the exact
    // wording the user half-remembers, which is often the literal string in the message.
    plan.keywords = Array.from(new Set([...plan.keywords, ...keywordsFromQuestion(question)]));

    const messages = await getMessagesSince(rangeSinceTs(plan.range));
    const todayMessages = plan.range === "today" ? messages : messages.filter((m) => m.ts >= startOfToday());

    // The full ranked match list goes back to the UI ("xem tất cả N tin khớp"), while only the top
    // slice is affordable to put in the prompt — a broad "tìm tất cả" over a week of rooms can match
    // hundreds of messages, far past what fits in a single request.
    const allMatches = plan.needs.includes("search") ? rankMessages(messages, plan) : [];

    const picked = new Map<string, StoredNivrisMessage>();
    for (const m of allMatches.slice(0, MAX_SEARCH_MESSAGES)) picked.set(m.id, m);
    if (plan.needs.includes("recent") || picked.size === 0) {
        const recent = [...messages].sort((a, b) => b.ts - a.ts).slice(0, MAX_RECENT_MESSAGES);
        for (const m of recent) picked.set(m.id, m);
    }

    // Chronological in the prompt (and so in the [#n] numbering) — a conversation read top-down is
    // far easier for the model to reason about than a relevance-ordered jumble.
    const context = Array.from(picked.values())
        .sort((a, b) => a.ts - b.ts)
        .slice(-MAX_CONTEXT_MESSAGES);

    const sideBlocks = await buildSideContext(plan, todayMessages);

    const client = getMatrixClient();
    const myName = client.getUser(client.getUserId() ?? "")?.displayName ?? "người dùng";

    const systemPrompt = [
        "Bạn là N.I.V.R.I.S. — trợ lý chat cá nhân chạy ngay trên máy của người dùng, có quyền đọc bộ nhớ đệm tin nhắn của họ trên MỌI phòng chat.",
        `Người dùng tên là "${myName}". Bây giờ là ${new Date().toLocaleString("vi-VN")}.`,
        "Bạn giúp họ: tìm lại tin nhắn đã quên (họ thường không nhớ ở phòng nào), tóm tắt một phòng/một người/cả ngày, chỉ ra việc cần làm và ai đang chờ trả lời, soạn giúp câu trả lời, và trả lời mọi câu hỏi khác dựa trên dữ liệu bên dưới.",
        "QUY TẮC:",
        "- Chỉ dựa trên dữ liệu được cung cấp. Không bịa tin nhắn, tên người, tên phòng hay con số. Thiếu dữ liệu thì nói thẳng là không có trong bộ nhớ đệm và gợi ý cách hỏi lại.",
        "- Khi nhắc tới một tin nhắn cụ thể, BẮT BUỘC chèn mã [#n] của tin đó ngay sau câu nhắc tới nó, để người dùng bấm mở được tin gốc. Nhắc tối đa 5 tin cho một câu trả lời, tin liên quan nhất trước.",
        "- Nếu người dùng nhờ soạn tin trả lời, viết thẳng nội dung tin nhắn để họ copy, không cần rào đón.",
        "- Trả lời ngắn gọn, tự nhiên bằng tiếng Việt, như đang nhắn tin. Dùng gạch đầu dòng khi liệt kê.",
        "",
        ...sideBlocks,
        "",
        allMatches.length > context.length
            ? `LƯU Ý: có tổng cộng ${allMatches.length} tin khớp từ khoá trong ${RANGE_LABEL[plan.range]}; dưới đây chỉ là ${context.length} tin liên quan nhất. Nếu người dùng muốn xem hết, nói cho họ biết có ${allMatches.length} tin khớp và họ bấm "XEM TẤT CẢ" dưới câu trả lời để xem đầy đủ.`
            : "",
        context.length
            ? `TIN NHẮN (${context.length} tin, ${RANGE_LABEL[plan.range]}):\n${context.map((m, i) => formatMessageLine(m, i + 1)).join("\n")}`
            : "TIN NHẮN: (bộ nhớ đệm chưa có tin nào trong khoảng thời gian này)",
    ]
        .filter(Boolean)
        .join("\n");

    const chat: NivrisMessage[] = [
        ...priorChat.slice(-MAX_CHAT_HISTORY_TURNS).map((m): NivrisMessage => ({ role: m.role, content: m.content })),
        { role: "user", content: question },
    ];

    let answer: string;
    try {
        answer = await askNivris(settings, systemPrompt, chat);
    } catch (e) {
        return {
            answer: e instanceof NivrisApiError ? e.message : `Lỗi: ${e instanceof Error ? e.message : String(e)}`,
            cited: [],
            usedCount: context.length,
            matches: allMatches.slice(0, MAX_RETURNED_MATCHES),
            matchTotal: allMatches.length,
            range: plan.range,
        };
    }

    // Rewrite the model's [#n] markers (indexes into the prompt's message list, meaningless to the
    // UI) into [[k]] markers indexing `cited`, so a stored chat message carries everything the
    // renderer needs to make each citation clickable without keeping the prompt around.
    const cited: StoredNivrisMessage[] = [];
    const rewritten = answer.replace(/\[#(\d+)\]/g, (_full, n: string) => {
        const msg = context[Number(n) - 1];
        if (!msg) return "";
        let k = cited.findIndex((c) => c.id === msg.id);
        if (k === -1) k = cited.push(msg) - 1;
        return `[[${k + 1}]]`;
    });

    return {
        answer: rewritten,
        cited,
        usedCount: context.length,
        matches: allMatches.slice(0, MAX_RETURNED_MATCHES),
        matchTotal: allMatches.length,
        range: plan.range,
    };
}
