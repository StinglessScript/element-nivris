/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useEffect, useMemo, useRef, useState } from "react";
import AiIcon from "@vector-im/compound-design-tokens/assets/web/icons/ai";
import SettingsIcon from "@vector-im/compound-design-tokens/assets/web/icons/settings";
import HomeIcon from "@vector-im/compound-design-tokens/assets/web/icons/home";
import PopOutIcon from "@vector-im/compound-design-tokens/assets/web/icons/pop-out";
import UserIcon from "@vector-im/compound-design-tokens/assets/web/icons/user";
import GroupIcon from "@vector-im/compound-design-tokens/assets/web/icons/group";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import MentionIcon from "@vector-im/compound-design-tokens/assets/web/icons/mention";
import CheckIcon from "@vector-im/compound-design-tokens/assets/web/icons/check";
import FavouriteSolidIcon from "@vector-im/compound-design-tokens/assets/web/icons/favourite-solid";
import BlockIcon from "@vector-im/compound-design-tokens/assets/web/icons/block";
import DocumentIcon from "@vector-im/compound-design-tokens/assets/web/icons/document";
import ChatSolidIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat-solid";
import ComposerIcon from "@vector-im/compound-design-tokens/assets/web/icons/compose";

import { useLocalStorageState } from "../useLocalStorageState";
import { DEFAULT_NIVRIS_SETTINGS, isNivrisConfigured, type NivrisSettings } from "../nivris/types";
import { JOB_TITLE_OPTIONS, type JobTitleValue } from "../nivris/constants";
import NivrisTrackerStore, {
    NIVRIS_TRACKER_STORE_CHANGE_EVENT,
    type NivrisChatMessage,
    type NivrisTrackerType,
    type NivrisUserTracker,
} from "../nivris/NivrisTrackerStore";
import {
    askTrackerQuestion,
    computeHomeOverview,
    computeTrackerMetrics,
    generateDailyReport,
    generateTrackerInsights,
    matchesInMessages,
    summarizeThread,
    type HomeOverview,
    type TrackerMetrics,
    type TrackerPriorityItem,
} from "../nivris/computeTrackerInsights";
import {
    DEFAULT_OUTPUT_STYLE,
    DEFAULT_TEMPLATES,
    NIVRIS_TEMPLATE_META,
    type NivrisTemplateKey,
} from "../nivris/outputTemplates";
import { ensureNivrisIngestStarted, rescanToday, runReportReminderCheckNow, startOfToday } from "../nivris/NivrisIngest";
import { getMatrixClient } from "../matrixClient";
import { clearAllMessages, getMessagesByThreadRoot, getMessagesSince, type StoredNivrisMessage } from "../nivris/NivrisMessageDb";
import { NIVRIS_VERSION } from "../nivris/changelog";
import NivrisReportStore, {
    NIVRIS_REPORT_STORE_CHANGE_EVENT,
    dayRange,
    formatReportDate,
    reportDateKey,
    shiftDateKey,
} from "../nivris/NivrisReportStore";
import NivrisEntityPicker, { type NivrisPickerEntity } from "./NivrisEntityPicker";
import { askAssistant, type AssistantChatMessage } from "../nivris/NivrisAssistant";
import { getCachedAvailableRelease, getInstalledSha, getUpdateState, type NivrisAvailableRelease } from "../nivris/NivrisUpdateChecker";
import NivrisDoneStore, { NIVRIS_DONE_STORE_CHANGE_EVENT } from "../nivris/NivrisDoneStore";
import { getModuleApi } from "../nivris/moduleApi";

/**
 * Jumps to a specific message in Element's own room view. Not a raw `window.location.hash` write
 * (what this used to do) — the Nivris workspace panel is mounted through Element's own space/
 * location router (registerLocationRenderer, see index.tsx), which has no visibility into a plain
 * hash change; leaving the "nivris" space active in Element's internal state while the hash points
 * at a room desyncs the two, and reported live as needing to switch spaces away and back twice to
 * recover. `toMatrixToLink` goes through the module API's own navigation, which keeps that state
 * in sync as part of leaving the module's space, same as clicking a real permalink would.
 */
function openMessageInElement(roomId: string, eventId: string): void {
    void getModuleApi().navigation.toMatrixToLink(`https://matrix.to/#/${roomId}/${eventId}`);
}

const TYPE_ICON: Record<NivrisTrackerType, JSX.Element> = {
    boss: <UserIcon width="13px" height="13px" />,
    group: <GroupIcon width="13px" height="13px" />,
    mention: <MentionIcon width="13px" height="13px" />,
    priority: <FavouriteSolidIcon width="13px" height="13px" />,
};

const TYPE_DOT: Record<NivrisTrackerType, string> = {
    boss: "#0fa3a0",
    group: "#0fa3a0",
    mention: "#c97a22",
    priority: "#6c5cff",
};

const TYPE_LABEL: Record<NivrisTrackerType, string> = {
    boss: "NGƯỜI",
    group: "PHÒNG",
    mention: "CỐ ĐỊNH",
    priority: "CỐ ĐỊNH",
};

const FIXED_LABEL: Record<Extract<NivrisTrackerType, "mention" | "priority">, string> = {
    mention: "@mình chưa phản hồi",
    priority: "Việc ưu tiên cao",
};

function trackerTitle(tracker: NivrisUserTracker): string {
    if (tracker.type === "mention" || tracker.type === "priority") return FIXED_LABEL[tracker.type];
    return tracker.label;
}

function groupKeyFor(tracker: NivrisUserTracker): string {
    return tracker.type === "mention" || tracker.type === "priority" ? "CỐ ĐỊNH" : tracker.type === "group" ? "PHÒNG" : "NGƯỜI";
}

/**
 * Cheap "did anything a screen can show actually change" fingerprint for a metrics map. Deliberately
 * only the fields the UI renders off (counts plus the newest matched message per tracker) — a deep
 * compare of every matched message would cost more than the re-render it saves.
 */
function metricsSignature(map: Record<string, TrackerMetrics | undefined>): string {
    return Object.keys(map)
        .sort()
        .map((id) => {
            const m = map[id];
            if (!m) return `${id}:-`;
            return `${id}:${m.total}:${m.awaitingReply}:${m.unreadCount}:${m.lastActivityTs ?? 0}:${m.matches[0]?.id ?? ""}`;
        })
        .join("|");
}

const NivrisWorkspace: React.FC = () => {
    const [settings, setSettings] = useLocalStorageState<NivrisSettings>("assistant_settings", DEFAULT_NIVRIS_SETTINGS);

    const [trackers, setTrackers] = useState(NivrisTrackerStore.instance.getTrackers());
    const [activeId, setActiveId] = useState(NivrisTrackerStore.instance.getActiveId());
    const [metricsMap, setMetricsMap] = useState<Record<string, TrackerMetrics | undefined>>({});
    const [analyzing, setAnalyzing] = useState(false);
    const [input, setInput] = useState("");
    const [pickerOpen, setPickerOpen] = useState(false);
    const [hint, setHint] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [reportOpen, setReportOpen] = useState(false);
    // The global assistant chat lives on the workspace (and in localStorage), not inside
    // AssistantView, so the conversation survives bouncing out to a session or to Element to check
    // a cited message — and survives a restart, same as any other chat app.
    const [assistantOpen, setAssistantOpen] = useState(false);
    const [assistantChat, setAssistantChat] = useLocalStorageState<AssistantChatMessage[]>("assistant_global_chat", []);
    const [assistantInput, setAssistantInput] = useState("");
    const [assistantSending, setAssistantSending] = useState(false);
    const [selectedMessage, setSelectedMessage] = useState<StoredNivrisMessage | null>(null);
    const [inspectorTab, setInspectorTab] = useState<"message" | "info" | "chat">("info");
    const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
    const [feedFilter, setFeedFilter] = useState<"open" | "done">("open");
    const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(NivrisDoneStore.instance.getAll());
    const [summaryOpen, setSummaryOpen] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [chatSending, setChatSending] = useState(false);
    const [threadSummaries, setThreadSummaries] = useState<Record<string, string[]>>({});
    const [summarizingThreadId, setSummarizingThreadId] = useState<string | null>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        void ensureNivrisIngestStarted();
        const onChange = (): void => {
            setTrackers(NivrisTrackerStore.instance.getTrackers());
            setActiveId(NivrisTrackerStore.instance.getActiveId());
        };
        NivrisTrackerStore.instance.on(NIVRIS_TRACKER_STORE_CHANGE_EVENT, onChange);

        const onDoneChange = (): void => setDoneIds(NivrisDoneStore.instance.getAll());
        NivrisDoneStore.instance.on(NIVRIS_DONE_STORE_CHANGE_EVENT, onDoneChange);

        return () => {
            NivrisTrackerStore.instance.off(NIVRIS_TRACKER_STORE_CHANGE_EVENT, onChange);
            NivrisDoneStore.instance.off(NIVRIS_DONE_STORE_CHANGE_EVENT, onDoneChange);
        };
    }, []);

    useEffect(() => {
        setSelectedMessage(null);
        setInspectorTab("info");
        setSummaryOpen(false);
        setFeedFilter("open");
    }, [activeId]);

    // Recomputed whenever the tracker list changes AND on a short poll, since new messages land in
    // the cache via live ingest/backfill independently of any tracker being added/removed — without
    // the poll, counts only ever refreshed if you removed and re-added a session.
    useEffect(() => {
        let cancelled = false;
        const refresh = async (): Promise<void> => {
            // A hidden window can't show a count, so the whole scan is skipped while Element is in
            // the background or on another space — this poll is the module's one constant cost, and
            // it was paying it every 10s whether or not anyone was looking. The visibilitychange
            // listener below refreshes immediately on the way back, so nothing looks stale.
            if (document.hidden) return;
            // Shared across every tracker so N trackers cost 1 IndexedDB scan per tick, not N.
            const todayMessages = await getMessagesSince(startOfToday());
            const entries = await Promise.all(
                trackers.map(async (t) => [t.id, await computeTrackerMetrics(t, todayMessages)] as const),
            );
            if (cancelled) return;
            // Most ticks find nothing new; replacing the map anyway handed every consumer a fresh
            // object identity and re-rendered the feed, the room tabs and the whole session list
            // once every 10 seconds for no visible change.
            setMetricsMap((prev) => {
                const next = Object.fromEntries(entries);
                return metricsSignature(prev) === metricsSignature(next) ? prev : next;
            });
        };
        void refresh();
        const intervalId = window.setInterval(() => void refresh(), 10_000);
        const onVisible = (): void => {
            if (!document.hidden) void refresh();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            cancelled = true;
            window.clearInterval(intervalId);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [trackers]);

    const activeTracker = trackers.find((t) => t.id === activeId) ?? null;
    const activeMetrics = activeTracker ? metricsMap[activeTracker.id] : undefined;

    // "Đã xem" started out mention-only (an @mention you've handled) but the same "I've read/dealt
    // with this one" gesture is what you want on a người/phòng session too, so every tracker type
    // gets the filter and the per-row toggle. Done state is keyed by message id, so a message that
    // shows up in two sessions is done in both.
    const matchesFeedFilter = (p: TrackerPriorityItem): boolean => doneIds.has(p.message.id) === (feedFilter === "done");
    // Room tabs (count + which rooms even show up) reflect the current Chưa xem/Đã xem filter —
    // reported live: a room tab kept showing its total count even after every @mention in it got
    // marked done, and stayed visible with nothing left to act on there. Both sides of the filter
    // stay grouped by room, so "Đã xem" is browsable per room the same way "Chưa xem" is.
    const visibleFeedGroups = (activeMetrics?.feedGroups ?? [])
        .map((g) => ({ ...g, items: g.items.filter(matchesFeedFilter) }))
        .filter((g) => g.items.length > 0);

    // Keep the room-tab selection valid as metrics load in/change, AND as rooms drop out of the
    // current filter (default to the busiest room still listed). Following the filtered groups is
    // what stops the feed dead-ending on an empty room right after you mark that room đã xem.
    const visibleRoomKey = visibleFeedGroups.map((g) => g.roomId).join("|");
    useEffect(() => {
        if (!visibleFeedGroups.some((g) => g.roomId === activeRoomId)) {
            setActiveRoomId(visibleFeedGroups[0]?.roomId ?? null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibleRoomKey, activeRoomId]);

    // Scoped to the selected room only — every bulk action below acts on this one group's items,
    // never on the other room tabs.
    const activeFeedGroup = visibleFeedGroups.find((g) => g.roomId === activeRoomId) ?? null;
    const visibleFeedItems = activeFeedGroup?.items ?? [];

    const onPickEntity = (entity: NivrisPickerEntity): void => {
        const type: NivrisTrackerType = entity.kind === "user" ? "boss" : "group";
        NivrisTrackerStore.instance.addTracker(type, entity.name, entity.id);
        setInput("");
        setPickerOpen(false);
        setHint(null);
    };

    const onCreateFixed = (type: "mention" | "priority"): void => {
        NivrisTrackerStore.instance.addTracker(type, FIXED_LABEL[type]);
    };

    const onAnalyze = async (): Promise<void> => {
        if (!activeTracker || !activeMetrics) return;
        if (!isNivrisConfigured(settings)) {
            setSettingsOpen(true);
            setHint("Cần cấu hình API AI trước khi phân tích.");
            return;
        }
        setAnalyzing(true);
        try {
            const insights = await generateTrackerInsights(activeTracker, settings, activeMetrics.matches);
            NivrisTrackerStore.instance.setInsights(activeTracker.id, insights);
        } finally {
            setAnalyzing(false);
        }
    };

    const onSendChat = async (): Promise<void> => {
        const question = chatInput.trim();
        if (!question || !activeTracker || chatSending) return;
        if (!isNivrisConfigured(settings)) {
            setSettingsOpen(true);
            setHint("Cần cấu hình API AI trước khi trò chuyện.");
            return;
        }

        const priorChat = activeTracker.chatMessages ?? [];
        NivrisTrackerStore.instance.appendChatMessages(activeTracker.id, [{ role: "user", content: question, ts: Date.now() }]);
        setChatInput("");
        setChatSending(true);
        try {
            const answer = await askTrackerQuestion(activeTracker, settings, activeMetrics?.matches ?? [], priorChat, question);
            NivrisTrackerStore.instance.appendChatMessages(activeTracker.id, [{ role: "assistant", content: answer, ts: Date.now() }]);
        } finally {
            setChatSending(false);
        }
    };

    const onSendAssistant = async (question: string): Promise<void> => {
        const trimmed = question.trim();
        if (!trimmed || assistantSending) return;
        if (!isNivrisConfigured(settings)) {
            setAssistantOpen(false);
            setSettingsOpen(true);
            return;
        }
        const priorChat = assistantChat;
        setAssistantChat([...priorChat, { role: "user", content: trimmed, ts: Date.now() }]);
        setAssistantInput("");
        setAssistantSending(true);
        try {
            const result = await askAssistant(settings, trimmed, priorChat);
            setAssistantChat(
                [
                    ...priorChat,
                    { role: "user" as const, content: trimmed, ts: Date.now() },
                    {
                        role: "assistant" as const,
                        content: result.answer,
                        ts: Date.now(),
                        cited: result.cited,
                        usedCount: result.usedCount,
                        matches: result.matches,
                        matchTotal: result.matchTotal,
                        range: result.range,
                    },
                    // Each turn carries its full match list, so an unbounded history would grow the
                    // localStorage entry without limit — keep the recent conversation, drop the tail.
                ].slice(-30),
            );
        } finally {
            setAssistantSending(false);
        }
    };

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ block: "end" });
    }, [activeTracker?.chatMessages, chatSending]);

    const onSummarizeThread = async (threadRootId: string): Promise<void> => {
        if (!isNivrisConfigured(settings)) {
            setSettingsOpen(true);
            setHint("Cần cấu hình API AI trước khi tóm tắt.");
            return;
        }
        setSummarizingThreadId(threadRootId);
        try {
            const threadMessages = await getMessagesByThreadRoot(threadRootId);
            const summary = await summarizeThread(settings, threadMessages);
            setThreadSummaries((prev) => ({ ...prev, [threadRootId]: summary }));
        } finally {
            setSummarizingThreadId(null);
        }
    };

    const filteredTrackers = trackers.filter((t) => trackerTitle(t).toLowerCase().includes(search.trim().toLowerCase()));
    const groupOrder = ["CỐ ĐỊNH", "NGƯỜI", "PHÒNG"];
    const groups = groupOrder
        .map((label) => ({ label, items: filteredTrackers.filter((t) => groupKeyFor(t) === label) }))
        .filter((g) => g.items.length > 0);

    return (
        <div className="mx_NivrisWorkspace">
            <header className="mx_NivrisWorkspace_header">
                <span className="mx_NivrisWorkspace_headerTitle">N.I.V.R.I.S.</span>
                <span className="mx_NivrisWorkspace_headerDivider" />
                <span className="mx_NivrisWorkspace_headerLive">
                    <i className="mx_NivrisWorkspace_liveDot" />
                    ĐANG LẮNG NGHE · {trackers.length} SESSION
                </span>
                <div className="mx_NivrisWorkspace_headerActions">
                    <button
                        className={`mx_NivrisWorkspace_iconBtn ${!activeId && !reportOpen && !assistantOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Về Home"
                        onClick={() => {
                            NivrisTrackerStore.instance.setActive(null);
                            setSettingsOpen(false);
                            setReportOpen(false);
                            setAssistantOpen(false);
                        }}
                    >
                        <HomeIcon width="15px" height="15px" />
                    </button>
                    <button
                        className={`mx_NivrisWorkspace_iconBtn ${assistantOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Trò chuyện với trợ lý"
                        onClick={() => {
                            setAssistantOpen((v) => !v);
                            setSettingsOpen(false);
                            setReportOpen(false);
                        }}
                    >
                        <ChatSolidIcon width="15px" height="15px" />
                    </button>
                    <button
                        className={`mx_NivrisWorkspace_iconBtn ${reportOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Báo cáo cuối ngày"
                        onClick={() => {
                            setReportOpen((v) => !v);
                            setAssistantOpen(false);
                            setSettingsOpen(false);
                        }}
                    >
                        <DocumentIcon width="15px" height="15px" />
                    </button>
                    <button
                        className={`mx_NivrisWorkspace_iconBtn ${settingsOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Cài đặt"
                        onClick={() => {
                            setSettingsOpen((v) => !v);
                            setAssistantOpen(false);
                            setReportOpen(false);
                        }}
                    >
                        <SettingsIcon width="15px" height="15px" />
                    </button>
                </div>
            </header>

            <div className="mx_NivrisWorkspace_split">
                <aside className="mx_NivrisWorkspace_sidebar">
                    <div className="mx_NivrisWorkspace_sidebarHead">
                        <div className="mx_NivrisWorkspace_sidebarLabel">SESSION</div>
                        <div className="mx_NivrisWorkspace_search">
                            <input placeholder="tìm session…" value={search} onChange={(e) => setSearch(e.target.value)} />
                        </div>
                    </div>
                    <div className="mx_NivrisWorkspace_sessionList">
                        {groups.length === 0 && (
                            <div className="mx_NivrisWorkspace_sessionEmpty">Chưa có session nào — thêm ở ô bên dưới.</div>
                        )}
                        {groups.map((group) => (
                            <div key={group.label}>
                                <div className="mx_NivrisWorkspace_sessionGroupLabel">{group.label}</div>
                                {group.items.map((tracker) => {
                                    const metrics = metricsMap[tracker.id];
                                    return (
                                        <button
                                            key={tracker.id}
                                            className={`mx_NivrisWorkspace_sessionRow ${tracker.id === activeId ? "mx_NivrisWorkspace_sessionRow_active" : ""}`}
                                            onClick={() => NivrisTrackerStore.instance.setActive(tracker.id)}
                                        >
                                            <span className="mx_NivrisWorkspace_sessionDot" style={{ backgroundColor: TYPE_DOT[tracker.type] }} />
                                            <span className="mx_NivrisWorkspace_sessionMain">
                                                <div className="mx_NivrisWorkspace_sessionName">{trackerTitle(tracker)}</div>
                                                <div className="mx_NivrisWorkspace_sessionMeta">
                                                    {metrics === undefined ? "đang tính…" : `${metrics.total} tin · ${metrics.roomsCount} phòng`}
                                                </div>
                                            </span>
                                            {!!metrics?.unreadCount && (
                                                <span className="mx_NivrisWorkspace_sessionBadge" title="Tin nhắn mới chưa xem">
                                                    {metrics.unreadCount}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                    <div className="mx_NivrisWorkspace_composerWrap">
                        <div className="mx_NivrisWorkspace_composer">
                            <span className="mx_NivrisWorkspace_composerPrompt">&gt;</span>
                            <div className="mx_NivrisWorkspace_composerMain">
                                <input
                                    ref={inputRef}
                                    placeholder="Gõ @tên người hoặc tên nhóm để thêm session..."
                                    value={input}
                                    onChange={(e) => {
                                        setInput(e.target.value);
                                        setPickerOpen(e.target.value.trim().length > 0);
                                        setHint(null);
                                    }}
                                    onFocus={() => input.trim() && setPickerOpen(true)}
                                    onBlur={() => window.setTimeout(() => setPickerOpen(false), 100)}
                                />
                                {pickerOpen && <NivrisEntityPicker query={input} onSelect={onPickEntity} />}
                            </div>
                        </div>
                        <div className="mx_NivrisWorkspace_quickActions">
                            <button onClick={() => onCreateFixed("mention")}>
                                <MentionIcon width="11px" height="11px" /> @ MENTION
                            </button>
                            <button onClick={() => onCreateFixed("priority")}>
                                <FavouriteSolidIcon width="11px" height="11px" /> ƯU TIÊN
                            </button>
                        </div>
                    </div>
                    <div className="mx_NivrisWorkspace_sidebarFoot">
                        <i className="mx_NivrisWorkspace_liveDot" style={{ width: 5, height: 5 }} />
                        INGEST · REALTIME
                    </div>
                </aside>

                <div className="mx_NivrisWorkspace_main">
                    {assistantOpen ? (
                        <AssistantView
                            chat={assistantChat}
                            input={assistantInput}
                            onInputChange={setAssistantInput}
                            sending={assistantSending}
                            onSend={(q) => void onSendAssistant(q)}
                            configured={isNivrisConfigured(settings)}
                            onOpenSettings={() => { setAssistantOpen(false); setSettingsOpen(true); }}
                            onClear={() => setAssistantChat([])}
                        />
                    ) : reportOpen ? (
                        <ReportView trackers={trackers} settings={settings} onOpenSettings={() => { setReportOpen(false); setSettingsOpen(true); }} />
                    ) : (
                        <>
                            <div className="mx_NivrisWorkspace_mainHead">
                                <div>
                                    <div className="mx_NivrisWorkspace_mainHeadName">
                                        <span className="mx_NivrisWorkspace_mainName">
                                            {activeTracker ? trackerTitle(activeTracker) : "Tổng quan"}
                                        </span>
                                        {activeTracker && (
                                            <span className="mx_NivrisWorkspace_typeBadge">{TYPE_LABEL[activeTracker.type]}</span>
                                        )}
                                    </div>
                                    {activeTracker && (
                                        <div className="mx_NivrisWorkspace_mainSource">
                                            {activeMetrics ? `${activeMetrics.roomsCount} phòng · ${activeMetrics.total} tin liên quan` : "đang tính…"}
                                        </div>
                                    )}
                                </div>
                                {activeTracker && (
                                    <div className="mx_NivrisWorkspace_statRow">
                                        <div className="mx_NivrisWorkspace_stat">
                                            <div className="mx_NivrisWorkspace_statLabel">TIN</div>
                                            <div className="mx_NivrisWorkspace_statNum">{activeMetrics?.total ?? "…"}</div>
                                        </div>
                                        <div className="mx_NivrisWorkspace_stat">
                                            <div className="mx_NivrisWorkspace_statLabel">PHÒNG</div>
                                            <div className="mx_NivrisWorkspace_statNum">{activeMetrics?.roomsCount ?? "…"}</div>
                                        </div>
                                        <div className="mx_NivrisWorkspace_stat mx_NivrisWorkspace_stat_warn">
                                            <div className="mx_NivrisWorkspace_statLabel">CHỜ</div>
                                            <div className="mx_NivrisWorkspace_statNum">{activeMetrics?.awaitingReply ?? "…"}</div>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="mx_NivrisWorkspace_mainBody">
                                {!activeTracker ? (
                                    <HomeOverviewView trackers={trackers} metricsMap={metricsMap} />
                                ) : (
                                    <>
                                        <section className="mx_NivrisWorkspace_aiCard">
                                            <div
                                                className="mx_NivrisWorkspace_aiCardHead"
                                                onClick={() => setSummaryOpen((v) => !v)}
                                                style={{ cursor: "pointer" }}
                                            >
                                                <i className="mx_NivrisWorkspace_liveDot" />
                                                <span className="mx_NivrisWorkspace_aiCardTitle">TÓM TẮT AI</span>
                                                {!summaryOpen && activeTracker.insights && (
                                                    <span className="mx_NivrisWorkspace_aiCardPreview">{activeTracker.insights[0]}</span>
                                                )}
                                                <span className="mx_NivrisWorkspace_aiCardChevron">{summaryOpen ? "▾" : "▸"}</span>
                                                <button
                                                    className="mx_NivrisWorkspace_aiCardAction"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSummaryOpen(true);
                                                        void onAnalyze();
                                                    }}
                                                    disabled={analyzing || !activeMetrics || activeMetrics.total === 0}
                                                >
                                                    {analyzing ? (
                                                        <span className="mx_NivrisWorkspace_spinner" />
                                                    ) : (
                                                        <AiIcon width="12px" height="12px" />
                                                    )}
                                                    {analyzing ? "ĐANG PHÂN TÍCH…" : activeTracker.insights ? "CHẠY LẠI" : "PHÂN TÍCH"}
                                                </button>
                                            </div>
                                            {summaryOpen && (
                                            <div className="mx_NivrisWorkspace_aiCardBody">
                                                {analyzing ? (
                                                    <div className="mx_NivrisWorkspace_aiLoading">
                                                        <span className="mx_NivrisWorkspace_spinner mx_NivrisWorkspace_spinner_lg" />
                                                        <div>
                                                            <div className="mx_NivrisWorkspace_aiLoadingTitle">Đang đọc {activeMetrics?.total ?? 0} tin nhắn…</div>
                                                            <div className="mx_NivrisWorkspace_aiLoadingSub">Gửi tới {settings.baseUrl || "endpoint chưa cấu hình"}</div>
                                                        </div>
                                                    </div>
                                                ) : !isNivrisConfigured(settings) ? (
                                                    <div className="mx_NivrisWorkspace_aiNotConfigured">
                                                        <div className="mx_NivrisWorkspace_aiEmpty">Chưa cấu hình AI — cần model, base URL và API key trước khi phân tích được.</div>
                                                        <button className="mx_NivrisWorkspace_storageSecondaryBtn" onClick={() => setSettingsOpen(true)}>
                                                            MỞ CÀI ĐẶT
                                                        </button>
                                                    </div>
                                                ) : activeTracker.insights ? (
                                                    activeTracker.insights.map((line, i) => (
                                                        <div className="mx_NivrisWorkspace_aiLine" key={i}>
                                                            <span>—</span>
                                                            <span>{line}</span>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <div className="mx_NivrisWorkspace_aiEmpty">
                                                        Chưa phân tích. Bấm "Phân tích" để AI đọc các tin nhắn liên quan.
                                                    </div>
                                                )}
                                            </div>
                                            )}
                                            {hint && !analyzing && <div className="mx_NivrisWorkspace_aiHint">{hint}</div>}
                                        </section>

                                        <section className="mx_NivrisWorkspace_feed">
                                            <div className="mx_NivrisWorkspace_feedHeader">
                                                <div className="mx_NivrisWorkspace_sectionLabel">TIN NỔI BẬT</div>
                                                {!!activeMetrics?.feedGroups.length && (
                                                    <div className="mx_NivrisWorkspace_segmented">
                                                        <button
                                                            className={`mx_NivrisWorkspace_segmentedBtn ${feedFilter === "open" ? "mx_NivrisWorkspace_segmentedBtn_active" : ""}`}
                                                            onClick={() => setFeedFilter("open")}
                                                        >
                                                            Chưa xem
                                                        </button>
                                                        <button
                                                            className={`mx_NivrisWorkspace_segmentedBtn ${feedFilter === "done" ? "mx_NivrisWorkspace_segmentedBtn_active" : ""}`}
                                                            onClick={() => setFeedFilter("done")}
                                                        >
                                                            Đã xem
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                            {!activeMetrics || activeMetrics.feedGroups.length === 0 ? (
                                                <div className="mx_NivrisWorkspace_feedEmpty">Chưa có tin nhắn nào khớp với session này.</div>
                                            ) : (
                                                <>
                                                    {visibleFeedGroups.length > 0 && (
                                                        <div className="mx_NivrisWorkspace_feedTabsRow">
                                                            <div className="mx_NivrisWorkspace_roomTabs">
                                                            {visibleFeedGroups.map((group) => (
                                                                <button
                                                                    key={group.roomId}
                                                                    className={`mx_NivrisWorkspace_roomTab ${group.roomId === activeRoomId ? "mx_NivrisWorkspace_roomTab_active" : ""}`}
                                                                    onClick={() => setActiveRoomId(group.roomId)}
                                                                >
                                                                    <span className="mx_NivrisWorkspace_roomTabDot" style={{ backgroundColor: group.color }} />
                                                                    {group.roomName}
                                                                    <span className="mx_NivrisWorkspace_roomTabCount">{group.items.length}</span>
                                                                </button>
                                                            ))}
                                                            </div>
                                                            {visibleFeedItems.length > 0 && (
                                                                <button
                                                                    className="mx_NivrisWorkspace_bulkDoneBtn"
                                                                    title={
                                                                        feedFilter === "done"
                                                                            ? `Chuyển ${visibleFeedItems.length} tin trong ${activeFeedGroup?.roomName ?? "phòng này"} về chưa xem`
                                                                            : `Đánh dấu ${visibleFeedItems.length} tin trong ${activeFeedGroup?.roomName ?? "phòng này"} là đã xem`
                                                                    }
                                                                    onClick={() =>
                                                                        NivrisDoneStore.instance.setManyDone(
                                                                            visibleFeedItems.map((item) => item.message.id),
                                                                            feedFilter === "open",
                                                                        )
                                                                    }
                                                                >
                                                                    <CheckIcon width="12px" height="12px" />
                                                                    {feedFilter === "done" ? "Chưa xem tất cả" : "Đã xem tất cả"}
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                    <div className="mx_NivrisWorkspace_feedList">
                                                        {visibleFeedItems.length === 0 ? (
                                                            <div className="mx_NivrisWorkspace_feedEmpty">
                                                                {feedFilter === "done" ? "Chưa đánh dấu tin nào là đã xem." : "Không còn tin nào chưa xem."}
                                                            </div>
                                                        ) : (
                                                            visibleFeedItems.map((p, i) => (
                                                                <div
                                                                    className={`mx_NivrisWorkspace_feedRow ${p.message.id === selectedMessage?.id ? "mx_NivrisWorkspace_feedRow_active" : ""}`}
                                                                    key={i}
                                                                >
                                                                    <button
                                                                        className="mx_NivrisWorkspace_feedRowMain"
                                                                        onClick={() => {
                                                                            setSelectedMessage(p.message);
                                                                            setInspectorTab("message");
                                                                        }}
                                                                    >
                                                                        <span className="mx_NivrisWorkspace_feedDot" style={{ backgroundColor: activeFeedGroup?.color }} />
                                                                        <div>
                                                                            <div className="mx_NivrisWorkspace_feedTitle">{p.title}</div>
                                                                            <div className="mx_NivrisWorkspace_feedMeta">{p.meta}</div>
                                                                        </div>
                                                                    </button>
                                                                    <div className="mx_NivrisWorkspace_feedRowActions">
                                                                        <button
                                                                            className={`mx_NivrisWorkspace_feedRowAction ${doneIds.has(p.message.id) ? "mx_NivrisWorkspace_feedRowAction_active" : ""}`}
                                                                            title={doneIds.has(p.message.id) ? "Bỏ đánh dấu đã xem" : "Đánh dấu đã xem"}
                                                                            onClick={() => NivrisDoneStore.instance.setDone(p.message.id, !doneIds.has(p.message.id))}
                                                                        >
                                                                            <CheckIcon width="13px" height="13px" />
                                                                        </button>
                                                                        <button
                                                                            className="mx_NivrisWorkspace_feedRowAction"
                                                                            title="Mở trong Element"
                                                                            onClick={() => openMessageInElement(p.message.roomId, p.message.id)}
                                                                        >
                                                                            <PopOutIcon width="13px" height="13px" />
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            ))
                                                        )}
                                                    </div>
                                                </>
                                            )}
                                        </section>
                                    </>
                                )}
                            </div>
                        </>
                    )}

                </div>

                {activeTracker && !reportOpen && !assistantOpen && (
                    <SessionInspector
                        tracker={activeTracker}
                        metrics={activeMetrics}
                        message={selectedMessage}
                        tab={inspectorTab}
                        onTabChange={setInspectorTab}
                        onRemoveTracker={() => NivrisTrackerStore.instance.removeTracker(activeTracker.id)}
                        chatInput={chatInput}
                        onChatInputChange={setChatInput}
                        chatSending={chatSending}
                        onSendChat={onSendChat}
                        chatEndRef={chatEndRef}
                        threadSummary={selectedMessage?.threadRootId ? threadSummaries[selectedMessage.threadRootId] : undefined}
                        summarizingThread={!!selectedMessage?.threadRootId && selectedMessage.threadRootId === summarizingThreadId}
                        onSummarizeThread={() => selectedMessage?.threadRootId && void onSummarizeThread(selectedMessage.threadRootId)}
                    />
                )}
            </div>

            {settingsOpen && (
                <SettingsPanel
                    settings={settings}
                    onClose={() => setSettingsOpen(false)}
                    onSave={(s) => setSettings(s)}
                    onChangeIgnoredRooms={(ignoredRoomIds) => setSettings({ ...settings, ignoredRoomIds })}
                    onChangeNotificationsEnabled={(notificationsEnabled) => setSettings({ ...settings, notificationsEnabled })}
                    onChangeReportReminder={(kind, enabled, time) =>
                        setSettings(
                            kind === "morning"
                                ? { ...settings, morningReportReminderEnabled: enabled, morningReportReminderTime: time }
                                : { ...settings, reportReminderEnabled: enabled, reportReminderTime: time },
                        )
                    }
                />
            )}
        </div>
    );
};

function linkHostname(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

function relTime(ts: number): string {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "vừa xong";
    if (mins < 60) return `${mins}p trước`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h trước`;
    return `${Math.round(hours / 24)} ngày trước`;
}

const ASSISTANT_SUGGESTIONS = [
    "Hôm nay có gì cần tôi trả lời?",
    "Ai đang chờ tôi lâu nhất?",
    "Tìm lại tin nhắn có link file hợp đồng",
    "Tóm tắt những gì đã chốt hôm nay",
];

/**
 * Renders an assistant answer, turning its [[k]] citation markers into chips that open the real
 * message in Element. The marker survives in the stored chat text (rather than the answer being
 * pre-rendered) so a reloaded conversation stays just as clickable as a fresh one.
 */
const AssistantAnswer: React.FC<{ content: string; cited: StoredNivrisMessage[] }> = ({ content, cited }) => (
    <>
        {content.split(/(\[\[\d+\]\])/g).map((part, i) => {
            const marker = part.match(/^\[\[(\d+)\]\]$/);
            if (!marker) return <span key={i}>{part}</span>;
            const msg = cited[Number(marker[1]) - 1];
            if (!msg) return null;
            return (
                <button
                    key={i}
                    className="mx_NivrisWorkspace_citeChip"
                    title={`${msg.senderName} · ${msg.roomName} — mở trong Element`}
                    onClick={() => openMessageInElement(msg.roomId, msg.id)}
                >
                    <PopOutIcon width="10px" height="10px" />
                    {msg.senderName}
                </button>
            );
        })}
    </>
);

/** A cited message, rendered as a card that opens it in Element. */
const AssistantSourceRow: React.FC<{ message: StoredNivrisMessage }> = ({ message }) => (
    <button
        className="mx_NivrisWorkspace_sourceCard"
        onClick={() => openMessageInElement(message.roomId, message.id)}
        title="Mở trong Element"
    >
        <div className="mx_NivrisWorkspace_sourceCardHead">
            <span className="mx_NivrisWorkspace_sourceCardWho">{message.senderName}</span>
            <span className="mx_NivrisWorkspace_sourceCardRoom">{message.roomName}</span>
            <span className="mx_NivrisWorkspace_sourceCardTime">{relTime(message.ts)}</span>
            <PopOutIcon width="11px" height="11px" />
        </div>
        <div className="mx_NivrisWorkspace_sourceCardText">
            {message.body.length > 180 ? `${message.body.slice(0, 180)}…` : message.body}
        </div>
    </button>
);

const RANGE_TEXT: Record<string, string> = {
    today: "hôm nay",
    "3d": "3 ngày gần đây",
    "7d": "7 ngày gần đây",
    all: "toàn bộ bộ nhớ đệm",
};

const MATCH_PAGE = 25;

/** One assistant turn: the answer, the messages it cited, and — on demand — every message the
 * search matched, not just the handful the answer had room to mention. */
const AssistantReply: React.FC<{ message: AssistantChatMessage }> = ({ message: m }) => {
    const [shown, setShown] = useState(0);

    const citedIds = new Set((m.cited ?? []).map((c) => c.id));
    const rest = (m.matches ?? []).filter((msg) => !citedIds.has(msg.id));
    // matchTotal counts every hit; `matches` is capped on the way out of askAssistant, so a very
    // broad search can have more hits than rows available to list here — say so rather than
    // silently showing fewer than the number on the button.
    const missing = (m.matchTotal ?? 0) - (m.cited?.length ?? 0) - rest.length;

    return (
        <div className="mx_NivrisWorkspace_assistantTurn">
            <div className="mx_NivrisWorkspace_assistantAvatar">
                <AiIcon width="13px" height="13px" />
            </div>
            <div className="mx_NivrisWorkspace_assistantReply">
                <div className="mx_NivrisWorkspace_assistantText">
                    <AssistantAnswer content={m.content} cited={m.cited ?? []} />
                </div>
                {!!m.cited?.length && (
                    <div className="mx_NivrisWorkspace_sourceList">
                        {m.cited.map((msg) => (
                            <AssistantSourceRow key={msg.id} message={msg} />
                        ))}
                    </div>
                )}

                {rest.length > 0 && (
                    <>
                        {shown > 0 && (
                            <div className="mx_NivrisWorkspace_sourceList">
                                {rest.slice(0, shown).map((msg) => (
                                    <AssistantSourceRow key={msg.id} message={msg} />
                                ))}
                            </div>
                        )}
                        <div className="mx_NivrisWorkspace_assistantMoreRow">
                            <button
                                className="mx_NivrisWorkspace_assistantMoreBtn"
                                onClick={() => setShown(shown > 0 ? 0 : MATCH_PAGE)}
                            >
                                {shown > 0 ? "ẨN DANH SÁCH" : `XEM TẤT CẢ ${rest.length} TIN KHỚP`}
                            </button>
                            {shown > 0 && shown < rest.length && (
                                <button
                                    className="mx_NivrisWorkspace_assistantMoreBtn"
                                    onClick={() => setShown(Math.min(rest.length, shown + MATCH_PAGE))}
                                >
                                    TẢI THÊM {Math.min(MATCH_PAGE, rest.length - shown)}
                                </button>
                            )}
                            {shown > 0 && missing > 0 && (
                                <span className="mx_NivrisWorkspace_assistantFootnote">
                                    (còn {missing} tin nữa — thu hẹp từ khoá để xem)
                                </span>
                            )}
                        </div>
                    </>
                )}

                {!!m.usedCount && (
                    <div className="mx_NivrisWorkspace_assistantFootnote">
                        đã đọc {m.usedCount} tin{m.range ? ` · ${RANGE_TEXT[m.range] ?? ""}` : ""}
                        {m.matchTotal ? ` · ${m.matchTotal} tin khớp` : ""}
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * The global assistant screen — an ordinary chat, deliberately not a search form: the useful
 * questions turned out to be broader than "find this message" ("hôm nay có gì cần trả lời", "tóm
 * tắt phòng X", "soạn giúp câu trả lời"), and a chat box asks for all of them equally well while a
 * search box quietly suggests only one of them is allowed.
 */
const AssistantView: React.FC<{
    chat: AssistantChatMessage[];
    input: string;
    onInputChange: (v: string) => void;
    sending: boolean;
    onSend: (question: string) => void;
    configured: boolean;
    onOpenSettings: () => void;
    onClear: () => void;
}> = ({ chat, input, onInputChange, sending, onSend, configured, onOpenSettings, onClear }) => {
    const endRef = useRef<HTMLDivElement>(null);
    const boxRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }, [chat, sending]);

    useEffect(() => {
        if (!input && boxRef.current) boxRef.current.style.height = "auto";
    }, [input]);

    return (
        <div className="mx_NivrisWorkspace_assistant">
            <div className="mx_NivrisWorkspace_assistantHead">
                <div>
                    <div className="mx_NivrisWorkspace_mainHeadName">
                        <span className="mx_NivrisWorkspace_mainName">Trợ lý</span>
                        <span className="mx_NivrisWorkspace_typeBadge">TOÀN BỘ PHÒNG</span>
                    </div>
                    <div className="mx_NivrisWorkspace_mainSource">
                        Hỏi bất cứ điều gì về tin nhắn của bạn — tìm lại tin đã quên, tóm tắt, việc cần làm, soạn câu trả lời.
                    </div>
                </div>
                {chat.length > 0 && (
                    <button className="mx_NivrisWorkspace_assistantNewBtn" onClick={onClear} disabled={sending}>
                        <ComposerIcon width="12px" height="12px" /> HỘI THOẠI MỚI
                    </button>
                )}
            </div>

            <div className="mx_NivrisWorkspace_assistantBody">
                {chat.length === 0 && !sending && (
                    <div className="mx_NivrisWorkspace_assistantWelcome">
                        <div className="mx_NivrisWorkspace_assistantWelcomeIcon">
                            <AiIcon width="22px" height="22px" />
                        </div>
                        <div className="mx_NivrisWorkspace_assistantWelcomeTitle">Tôi đọc được mọi phòng bạn đang nghe</div>
                        <div className="mx_NivrisWorkspace_assistantWelcomeSub">
                            Không nhớ tin nhắn đó ở đâu cũng không sao — cứ mô tả bằng lời, tôi tìm và mở giúp.
                        </div>
                        <div className="mx_NivrisWorkspace_assistantSuggestions">
                            {ASSISTANT_SUGGESTIONS.map((q) => (
                                <button key={q} onClick={() => onSend(q)} disabled={!configured}>
                                    {q}
                                </button>
                            ))}
                        </div>
                        {!configured && (
                            <button className="mx_NivrisWorkspace_storageSecondaryBtn" onClick={onOpenSettings}>
                                CHƯA CẤU HÌNH AI — MỞ CÀI ĐẶT
                            </button>
                        )}
                    </div>
                )}

                {chat.map((m, i) =>
                    m.role === "user" ? (
                        <div className="mx_NivrisWorkspace_assistantTurn mx_NivrisWorkspace_assistantTurn_user" key={i}>
                            <div className="mx_NivrisWorkspace_chatBubble mx_NivrisWorkspace_chatBubble_user">{m.content}</div>
                        </div>
                    ) : (
                        <AssistantReply key={i} message={m} />
                    ),
                )}

                {sending && (
                    <div className="mx_NivrisWorkspace_assistantTurn">
                        <div className="mx_NivrisWorkspace_assistantAvatar">
                            <AiIcon width="13px" height="13px" />
                        </div>
                        <div className="mx_NivrisWorkspace_assistantReply">
                            <div className="mx_NivrisWorkspace_assistantTyping">
                                <span className="mx_NivrisWorkspace_spinner" /> đang đọc tin nhắn…
                            </div>
                        </div>
                    </div>
                )}
                <div ref={endRef} />
            </div>

            <div className="mx_NivrisWorkspace_assistantComposer">
                <textarea
                    ref={boxRef}
                    placeholder={configured ? "Nhắn cho trợ lý…" : "Cần cấu hình AI trong Cài đặt trước khi trò chuyện"}
                    value={input}
                    onChange={(e) => {
                        onInputChange(e.target.value);
                        // Grow with the text up to the CSS max-height, like any chat composer —
                        // rows={1} alone would keep a multi-line draft scrolling inside one line.
                        e.target.style.height = "auto";
                        e.target.style.height = `${e.target.scrollHeight}px`;
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            onSend(input);
                        }
                    }}
                    disabled={sending}
                    rows={1}
                />
                <button
                    className="mx_NivrisWorkspace_assistantSend"
                    onClick={() => onSend(input)}
                    disabled={sending || !input.trim()}
                    title="Gửi (Enter)"
                >
                    {sending ? <span className="mx_NivrisWorkspace_spinner" /> : <AiIcon width="14px" height="14px" />}
                </button>
            </div>
        </div>
    );
};

const HomeOverviewView: React.FC<{
    trackers: NivrisUserTracker[];
    metricsMap: Record<string, TrackerMetrics | undefined>;
}> = ({ trackers, metricsMap }) => {
    const [overview, setOverview] = useState<HomeOverview | null>(null);

    useEffect(() => {
        let cancelled = false;
        void computeHomeOverview().then((o) => {
            if (!cancelled) setOverview(o);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const waitingSessions = trackers.filter((t) => !!metricsMap[t.id]?.awaitingReply);
    const totalWaiting = waitingSessions.reduce((sum, t) => sum + (metricsMap[t.id]?.awaitingReply ?? 0), 0);
    const maxHour = Math.max(1, ...(overview?.hours.map((h) => h.total) ?? [1]));

    return (
        <div className="mx_NivrisWorkspace_home">
            <div className="mx_NivrisWorkspace_homeStatus">
                <div className="mx_NivrisWorkspace_sectionLabel">TRẠNG THÁI</div>
                <div className="mx_NivrisWorkspace_homeHero">
                    <div className="mx_NivrisWorkspace_homeHeroLabel">CHỜ BẠN TRẢ LỜI</div>
                    <div className="mx_NivrisWorkspace_homeHeroRow">
                        <span className="mx_NivrisWorkspace_homeHeroNum">{totalWaiting}</span>
                        <span className="mx_NivrisWorkspace_homeHeroSub">trên {waitingSessions.length} session</span>
                    </div>
                </div>
                <div className="mx_NivrisWorkspace_homeMiniStats">
                    <div className="mx_NivrisWorkspace_homeMiniStat mx_NivrisWorkspace_homeMiniStat_warn">
                        <div className="mx_NivrisWorkspace_statLabel">QUÁ HẠN 4H</div>
                        <div className="mx_NivrisWorkspace_homeMiniNum">{overview?.overdueCount ?? "…"}</div>
                    </div>
                    <div className="mx_NivrisWorkspace_homeMiniStat">
                        <div className="mx_NivrisWorkspace_statLabel">TIN HÔM NAY</div>
                        <div className="mx_NivrisWorkspace_homeMiniNum">{overview?.totalToday ?? "…"}</div>
                    </div>
                </div>

                {trackers.length === 0 && (
                    <div className="mx_NivrisWorkspace_feedEmpty">Chưa có session nào — thêm ở ô bên dưới, hoặc chọn ở sidebar bên trái.</div>
                )}
                <div className="mx_NivrisWorkspace_homeFootnote">
                    INGEST · REALTIME
                    <br />
                    MỌI XỬ LÝ CHẠY TRÊN MÁY BẠN
                </div>
            </div>

            <div className="mx_NivrisWorkspace_homeCenter">
                <div>
                    <div className="mx_NivrisWorkspace_sectionLabel">NHỊP TIN 24 GIỜ</div>
                    <div className="mx_NivrisWorkspace_homeChartSub">
                        {overview
                            ? `${overview.totalToday} tin${overview.peakHourLabel ? ` · cao điểm ${overview.peakHourLabel}` : ""} · ${overview.roomsListening} phòng đang nghe`
                            : "đang tính…"}
                    </div>
                </div>

                <div className="mx_NivrisWorkspace_homeChart">
                    {(overview?.hours ?? []).map((h) => (
                        <div className="mx_NivrisWorkspace_homeChartCol" key={h.hour}>
                            <div
                                className="mx_NivrisWorkspace_homeChartBar mx_NivrisWorkspace_homeChartBar_mention"
                                style={{ height: `${maxHour ? (h.mentions / maxHour) * 100 : 0}%` }}
                            />
                            <div
                                className="mx_NivrisWorkspace_homeChartBar"
                                style={{ height: `${maxHour ? (h.total / maxHour) * 100 : 0}%` }}
                            />
                            {h.hour % 3 === 0 && <div className="mx_NivrisWorkspace_homeChartLabel">{h.label}</div>}
                        </div>
                    ))}
                </div>

                <div className="mx_NivrisWorkspace_homeSplit">
                    <div>
                        <div className="mx_NivrisWorkspace_sectionLabel">PHÒNG SÔI ĐỘNG</div>
                        {(overview?.busyRooms.length ?? 0) === 0 ? (
                            <div className="mx_NivrisWorkspace_feedEmpty">Chưa có dữ liệu hôm nay.</div>
                        ) : (
                            overview!.busyRooms.map((r) => (
                                <div className="mx_NivrisWorkspace_distRow" key={r.roomId}>
                                    <span className="mx_NivrisWorkspace_distLabel">{r.room}</span>
                                    <div className="mx_NivrisWorkspace_distTrack">
                                        <div
                                            className="mx_NivrisWorkspace_distFill"
                                            style={{ width: `${(r.count / (overview!.busyRooms[0].count || 1)) * 100}%` }}
                                        />
                                    </div>
                                    <span className="mx_NivrisWorkspace_distPct">{r.count}</span>
                                </div>
                            ))
                        )}
                    </div>
                    <div className="mx_NivrisWorkspace_homeWaiters">
                        <div className="mx_NivrisWorkspace_sectionLabel">NGƯỜI ĐANG CHỜ BẠN</div>
                        {(overview?.waiters.length ?? 0) === 0 ? (
                            <div className="mx_NivrisWorkspace_feedEmpty">Không ai đang chờ bạn trả lời.</div>
                        ) : (
                            overview!.waiters.map((w, i) => (
                                <div className="mx_NivrisWorkspace_homeWaiterRow" key={i}>
                                    <span className="mx_NivrisWorkspace_homeWaiterInitial">{w.senderName.slice(0, 1).toUpperCase()}</span>
                                    <span className="mx_NivrisWorkspace_homeWaiterName">{w.senderName}</span>
                                    <span className={`mx_NivrisWorkspace_homeWaiterAgo ${w.overdue ? "mx_NivrisWorkspace_homeWaiterAgo_warn" : ""}`}>
                                        {relTime(w.ts)}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

const SessionInspector: React.FC<{
    tracker: NivrisUserTracker;
    metrics: TrackerMetrics | undefined;
    message: StoredNivrisMessage | null;
    tab: "message" | "info" | "chat";
    onTabChange: (tab: "message" | "info" | "chat") => void;
    onRemoveTracker: () => void;
    chatInput: string;
    onChatInputChange: (v: string) => void;
    chatSending: boolean;
    onSendChat: () => void;
    chatEndRef: React.RefObject<HTMLDivElement | null>;
    threadSummary: string[] | undefined;
    summarizingThread: boolean;
    onSummarizeThread: () => void;
}> = ({
    tracker,
    metrics,
    message,
    tab,
    onTabChange,
    onRemoveTracker,
    chatInput,
    onChatInputChange,
    chatSending,
    onSendChat,
    chatEndRef,
    threadSummary,
    summarizingThread,
    onSummarizeThread,
}) => {
    const inThread = !!message?.threadRootId && message.threadRootId !== message.id;

    return (
        <aside className="mx_NivrisWorkspace_inspector">
            <div className="mx_NivrisWorkspace_inspectorTabs">
                <button
                    className={`mx_NivrisWorkspace_inspectorTab ${tab === "chat" ? "mx_NivrisWorkspace_inspectorTab_active" : ""}`}
                    onClick={() => onTabChange("chat")}
                >
                    TRÒ CHUYỆN
                </button>
                <button
                    className={`mx_NivrisWorkspace_inspectorTab ${tab === "message" ? "mx_NivrisWorkspace_inspectorTab_active" : ""}`}
                    onClick={() => onTabChange("message")}
                >
                    CHI TIẾT TIN
                </button>
                <button
                    className={`mx_NivrisWorkspace_inspectorTab ${tab === "info" ? "mx_NivrisWorkspace_inspectorTab_active" : ""}`}
                    onClick={() => onTabChange("info")}
                >
                    THÔNG TIN
                </button>
            </div>

            {tab === "chat" ? (
                <>
                    <div className="mx_NivrisWorkspace_chatMessages">
                        {(tracker.chatMessages ?? []).length === 0 && !chatSending && (
                            <div className="mx_NivrisWorkspace_aiEmpty">
                                Hỏi AI bất cứ điều gì về session này — vd. "Hôm nay có ai nhắc deadline gì không?"
                            </div>
                        )}
                        {(tracker.chatMessages ?? []).map((m, i) => (
                            <div key={i} className={`mx_NivrisWorkspace_chatBubble mx_NivrisWorkspace_chatBubble_${m.role}`}>
                                {m.content}
                            </div>
                        ))}
                        {chatSending && (
                            <div className="mx_NivrisWorkspace_chatBubble mx_NivrisWorkspace_chatBubble_assistant">
                                <span className="mx_NivrisWorkspace_spinner" /> đang trả lời…
                            </div>
                        )}
                        <div ref={chatEndRef} />
                    </div>
                    <div className="mx_NivrisWorkspace_chatComposer">
                        <textarea
                            placeholder="Hỏi AI về session này..."
                            value={chatInput}
                            onChange={(e) => onChatInputChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    onSendChat();
                                }
                            }}
                            disabled={chatSending}
                            rows={2}
                        />
                        <button
                            className="mx_NivrisWorkspace_settingsSave"
                            onClick={onSendChat}
                            disabled={chatSending || !chatInput.trim()}
                        >
                            GỬI
                        </button>
                    </div>
                </>
            ) : tab === "message" ? (
                message ? (
                    <>
                        <div className="mx_NivrisWorkspace_inspectorBreadcrumb">
                            {message.roomName}
                            <span className={`mx_NivrisWorkspace_threadBadge ${inThread ? "" : "mx_NivrisWorkspace_threadBadge_none"}`}>
                                {inThread ? "TRONG THREAD" : "CHƯA CÓ THREAD"}
                            </span>
                        </div>
                        <div className="mx_NivrisWorkspace_inspectorBody">
                            <div className="mx_NivrisWorkspace_msgCard">
                                <div className="mx_NivrisWorkspace_msgCardHead">
                                    <span className="mx_NivrisWorkspace_msgCardWho">{message.senderName}</span>
                                    <span className="mx_NivrisWorkspace_msgCardTime">{new Date(message.ts).toLocaleString("vi-VN")}</span>
                                </div>
                                <div className="mx_NivrisWorkspace_msgCardText">{message.body}</div>
                            </div>
                            {inThread && (
                                <div className="mx_NivrisWorkspace_inspectorNote">
                                    Tin này nằm trong 1 thread — mở trong Element để xem toàn bộ các trả lời.
                                </div>
                            )}
                            {inThread && (
                                <section className="mx_NivrisWorkspace_aiCard">
                                    <div className="mx_NivrisWorkspace_aiCardHead">
                                        <i className="mx_NivrisWorkspace_liveDot" />
                                        <span className="mx_NivrisWorkspace_aiCardTitle">TÓM TẮT THREAD</span>
                                        <button
                                            className="mx_NivrisWorkspace_aiCardAction"
                                            onClick={onSummarizeThread}
                                            disabled={summarizingThread}
                                        >
                                            {summarizingThread ? (
                                                <span className="mx_NivrisWorkspace_spinner" />
                                            ) : (
                                                <AiIcon width="12px" height="12px" />
                                            )}
                                            {summarizingThread ? "ĐANG TÓM TẮT…" : threadSummary ? "TÓM TẮT LẠI" : "TÓM TẮT"}
                                        </button>
                                    </div>
                                    <div className="mx_NivrisWorkspace_aiCardBody">
                                        {summarizingThread ? (
                                            <div className="mx_NivrisWorkspace_aiLoading">
                                                <span className="mx_NivrisWorkspace_spinner mx_NivrisWorkspace_spinner_lg" />
                                                <div className="mx_NivrisWorkspace_aiLoadingTitle">Đang đọc thread…</div>
                                            </div>
                                        ) : threadSummary ? (
                                            threadSummary.map((line, i) => (
                                                <div className="mx_NivrisWorkspace_aiLine" key={i}>
                                                    <span>—</span>
                                                    <span>{line}</span>
                                                </div>
                                            ))
                                        ) : (
                                            <div className="mx_NivrisWorkspace_aiEmpty">
                                                Chưa tóm tắt. Bấm "Tóm tắt" để AI đọc toàn bộ tin trong thread này.
                                            </div>
                                        )}
                                    </div>
                                </section>
                            )}
                        </div>
                        <div className="mx_NivrisWorkspace_inspectorFoot">
                            <button
                                className="mx_NivrisWorkspace_inspectorPrimary"
                                onClick={() => openMessageInElement(message.roomId, message.id)}
                            >
                                MỞ TRONG ELEMENT
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="mx_NivrisWorkspace_inspectorBody">
                        <div className="mx_NivrisWorkspace_inspectorHint">Bấm vào 1 tin trong "Tin nổi bật" để xem chi tiết ở đây.</div>
                    </div>
                )
            ) : (
                <>
                    <div className="mx_NivrisWorkspace_inspectorBody">
                        <div>
                            <div className="mx_NivrisWorkspace_inspectorFieldLabel">TÊN</div>
                            <div className="mx_NivrisWorkspace_inspectorFieldValue">{trackerTitle(tracker)}</div>
                            <div className="mx_NivrisWorkspace_inspectorFieldLabel">LOẠI</div>
                            <div className="mx_NivrisWorkspace_inspectorFieldValue">{TYPE_LABEL[tracker.type]}</div>
                        </div>

                        {tracker.type === "boss" && (
                            <div className="mx_NivrisWorkspace_settingsField">
                                <label className="mx_NivrisWorkspace_roomIgnoreItem" style={{ border: "none", padding: 0 }}>
                                    <input
                                        type="checkbox"
                                        checked={!!tracker.isEmployee}
                                        onChange={(e) => NivrisTrackerStore.instance.setEmployeeTag(tracker.id, e.target.checked)}
                                    />
                                    <span>Đưa vào báo cáo cuối ngày</span>
                                </label>
                                <label className="mx_NivrisWorkspace_settingsLabel">VỊ TRÍ CÔNG VIỆC (VTCV)</label>
                                <select
                                    className="mx_NivrisWorkspace_settingsInput"
                                    value={tracker.jobTitle ?? ""}
                                    onChange={(e) =>
                                        NivrisTrackerStore.instance.setJobTitle(
                                            tracker.id,
                                            (e.target.value || undefined) as JobTitleValue | undefined,
                                        )
                                    }
                                >
                                    <option value="">— Chưa chọn —</option>
                                    {JOB_TITLE_OPTIONS.map((o) => (
                                        <option key={o.value} value={o.value}>
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {!!metrics?.teamWeights.length && (
                            <div>
                                <div className="mx_NivrisWorkspace_inspectorFieldLabel">PHÂN BỐ THEO PHÒNG</div>
                                <div className="mx_NivrisWorkspace_distList">
                                    {metrics.teamWeights.map((row, i) => (
                                        <div className="mx_NivrisWorkspace_distRow" key={i}>
                                            <span className="mx_NivrisWorkspace_distLabel">{row.label}</span>
                                            <div className="mx_NivrisWorkspace_distTrack">
                                                <div className="mx_NivrisWorkspace_distFill" style={{ width: `${row.percent}%` }} />
                                            </div>
                                            <span className="mx_NivrisWorkspace_distPct">{row.percent}%</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="mx_NivrisWorkspace_inspectorFoot">
                        <button className="mx_NivrisWorkspace_dangerBtn" onClick={onRemoveTracker}>
                            <BlockIcon width="13px" height="13px" /> Dừng theo dõi session
                        </button>
                    </div>
                </>
            )}
        </aside>
    );
};

const ReportView: React.FC<{
    trackers: NivrisUserTracker[];
    settings: NivrisSettings;
    onOpenSettings: () => void;
}> = ({ trackers, settings, onOpenSettings }) => {
    const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
    const [archiveVersion, setArchiveVersion] = useState(0);
    const [date, setDate] = useState(reportDateKey());
    // Matches for the selected day, per person — loaded from the cache for whatever day is showing,
    // so an older day is generated from that day's messages instead of today's.
    const [dayMatches, setDayMatches] = useState<Record<string, StoredNivrisMessage[]> | null>(null);
    const employees = trackers.filter((t) => t.type === "boss" && t.isEmployee);
    const today = reportDateKey();
    const isToday = date === today;

    useEffect(() => {
        const onChange = (): void => setArchiveVersion((v) => v + 1);
        NivrisReportStore.instance.on(NIVRIS_REPORT_STORE_CHANGE_EVENT, onChange);
        return () => {
            NivrisReportStore.instance.off(NIVRIS_REPORT_STORE_CHANGE_EVENT, onChange);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setDayMatches(null);
        const load = async (): Promise<void> => {
            const { from, to } = dayRange(date);
            // One IndexedDB read for the day, shared across every person on the screen.
            const messages = (await getMessagesSince(from)).filter((m) => m.ts < to);
            const entries = await Promise.all(
                employees.map(async (t) => [t.id, await matchesInMessages(t, messages)] as const),
            );
            if (!cancelled) setDayMatches(Object.fromEntries(entries));
        };
        void load();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [date, employees.map((t) => t.id).join("|")]);

    const generateFor = async (tracker: NivrisUserTracker): Promise<void> => {
        const matches = dayMatches?.[tracker.id];
        if (!matches?.length) return;
        setGeneratingIds((prev) => new Set(prev).add(tracker.id));
        try {
            const text = await generateDailyReport(tracker, settings, matches);
            NivrisReportStore.instance.setReport(date, {
                trackerId: tracker.id,
                trackerLabel: trackerTitle(tracker),
                roleLabel: JOB_TITLE_OPTIONS.find((o) => o.value === tracker.jobTitle)?.label,
                text,
                generatedAt: Date.now(),
            });
        } finally {
            setGeneratingIds((prev) => {
                const next = new Set(prev);
                next.delete(tracker.id);
                return next;
            });
        }
    };

    const generateAll = (): void => {
        for (const t of employees) void generateFor(t);
    };

    // Re-read on save (archiveVersion) as well as on date change.
    const storedForDate = useMemo(
        () => NivrisReportStore.instance.getForDate(date),
        [date, archiveVersion],
    );
    const anyMessagesThatDay = !!dayMatches && Object.values(dayMatches).some((m) => m.length > 0);
    // People who are no longer tagged for reports but do have a report saved on this day — without
    // this, removing someone from the report list would hide their past write-ups.
    const orphanReports = storedForDate.filter((r) => !employees.some((t) => t.id === r.trackerId));

    return (
        <div className="mx_NivrisWorkspace_mainBody">
            <div className="mx_NivrisWorkspace_mainHead" style={{ padding: 0, border: "none" }}>
                <div>
                    <div className="mx_NivrisWorkspace_mainHeadName">
                        <span className="mx_NivrisWorkspace_mainName">Báo cáo cuối ngày</span>
                    </div>
                    <div className="mx_NivrisWorkspace_mainSource">{employees.length} người được gắn vào báo cáo</div>
                </div>
                {employees.length > 0 && (
                    <button
                        className="mx_NivrisWorkspace_aiCardAction"
                        onClick={generateAll}
                        disabled={!isNivrisConfigured(settings) || generatingIds.size > 0 || !anyMessagesThatDay}
                    >
                        <AiIcon width="12px" height="12px" /> TẠO BÁO CÁO CHO TẤT CẢ
                    </button>
                )}
            </div>

            <div className="mx_NivrisWorkspace_reportDates">
                <button
                    className="mx_NivrisWorkspace_reportDateStep"
                    title="Ngày trước"
                    onClick={() => setDate(shiftDateKey(date, -1))}
                >
                    ‹
                </button>
                <input
                    type="date"
                    className="mx_NivrisWorkspace_reportDateInput"
                    value={date}
                    max={today}
                    onChange={(e) => e.target.value && setDate(e.target.value)}
                />
                <button
                    className="mx_NivrisWorkspace_reportDateStep"
                    title="Ngày sau"
                    disabled={isToday}
                    onClick={() => setDate(shiftDateKey(date, 1))}
                >
                    ›
                </button>
                <span className="mx_NivrisWorkspace_reportDateLabel">{formatReportDate(date)}</span>
                {!isToday && (
                    <button className="mx_NivrisWorkspace_storageSecondaryBtn" onClick={() => setDate(today)}>
                        VỀ HÔM NAY
                    </button>
                )}
            </div>

            {!isNivrisConfigured(settings) && (
                <div className="mx_NivrisWorkspace_aiNotConfigured" style={{ marginTop: 14 }}>
                    <div className="mx_NivrisWorkspace_aiEmpty">Chưa cấu hình AI — cần model, base URL và API key trước khi tạo báo cáo được.</div>
                    <button className="mx_NivrisWorkspace_storageSecondaryBtn" onClick={onOpenSettings}>
                        MỞ CÀI ĐẶT
                    </button>
                </div>
            )}

            {employees.length === 0 && orphanReports.length === 0 ? (
                <div className="mx_NivrisWorkspace_aiEmpty" style={{ marginTop: 14 }}>
                    Chưa có ai được gắn vào báo cáo. Mở 1 session "NGƯỜI" (nhân viên hoặc sếp) → tab "THÔNG TIN" → tick "Đưa vào báo cáo cuối ngày" và điền vị trí công việc để đưa vào đây.
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
                    {employees.map((t) => {
                        const generating = generatingIds.has(t.id);
                        const matches = dayMatches?.[t.id];
                        const stored = storedForDate.find((r) => r.trackerId === t.id);
                        return (
                            <section className="mx_NivrisWorkspace_aiCard" key={t.id}>
                                <div className="mx_NivrisWorkspace_aiCardHead">
                                    <i className="mx_NivrisWorkspace_liveDot" />
                                    <span className="mx_NivrisWorkspace_aiCardTitle">
                                        {trackerTitle(t).toUpperCase()}
                                        {(() => {
                                            const role = JOB_TITLE_OPTIONS.find((o) => o.value === t.jobTitle);
                                            return role ? ` · ${role.label}` : "";
                                        })()}
                                    </span>
                                    <span className="mx_NivrisWorkspace_aiCardPreview">
                                        {matches === undefined ? "đang đọc cache…" : `${matches.length} tin ngày này`}
                                    </span>
                                    <button
                                        className="mx_NivrisWorkspace_aiCardAction"
                                        onClick={() => void generateFor(t)}
                                        disabled={generating || !isNivrisConfigured(settings) || !matches?.length}
                                        title={matches && !matches.length ? "Không có tin nhắn nào của người này trong cache ngày này" : undefined}
                                    >
                                        {generating ? <span className="mx_NivrisWorkspace_spinner" /> : <AiIcon width="12px" height="12px" />}
                                        {generating ? "ĐANG TẠO…" : stored ? "TẠO LẠI" : "TẠO BÁO CÁO"}
                                    </button>
                                </div>
                                <div className="mx_NivrisWorkspace_aiCardBody">
                                    {stored ? (
                                        <>
                                            <div className="mx_NivrisWorkspace_reportText">{stored.text}</div>
                                            <div className="mx_NivrisWorkspace_reportMeta">
                                                Tạo lúc {new Date(stored.generatedAt).toLocaleString("vi-VN")}
                                            </div>
                                        </>
                                    ) : (
                                        <div className="mx_NivrisWorkspace_aiEmpty">
                                            {matches?.length === 0
                                                ? "Không có tin nhắn nào trong cache cho ngày này."
                                                : "Chưa tạo báo cáo cho ngày này."}
                                        </div>
                                    )}
                                </div>
                            </section>
                        );
                    })}

                    {orphanReports.map((r) => (
                        <section className="mx_NivrisWorkspace_aiCard" key={r.trackerId}>
                            <div className="mx_NivrisWorkspace_aiCardHead">
                                <i className="mx_NivrisWorkspace_liveDot" />
                                <span className="mx_NivrisWorkspace_aiCardTitle">
                                    {r.trackerLabel.toUpperCase()}
                                    {r.roleLabel ? ` · ${r.roleLabel}` : ""}
                                </span>
                                <span className="mx_NivrisWorkspace_aiCardPreview">không còn trong danh sách báo cáo</span>
                            </div>
                            <div className="mx_NivrisWorkspace_aiCardBody">
                                <div className="mx_NivrisWorkspace_reportText">{r.text}</div>
                                <div className="mx_NivrisWorkspace_reportMeta">
                                    Tạo lúc {new Date(r.generatedAt).toLocaleString("vi-VN")}
                                </div>
                            </div>
                        </section>
                    ))}
                </div>
            )}
        </div>
    );
};

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where scripts/lib/finish.ts writes the combined install + helper report. Kept in sync by hand
 * with that file — the module can't ask the installer, and hardcoding the one path it uses beats
 * showing nothing. */
function installLogPath(): string {
    return navigator.userAgent.includes("Windows")
        ? "%APPDATA%\\Nivris\\bao-cao-cai-dat.txt"
        : "~/Library/Application Support/Nivris/bao-cao-cai-dat.txt";
}

type SettingsTab = "ai" | "notif" | "data" | "system";

const SettingsPanel: React.FC<{
    settings: NivrisSettings;
    onSave: (s: NivrisSettings) => void;
    onClose: () => void;
    onChangeIgnoredRooms: (ignoredRoomIds: string[]) => void;
    onChangeNotificationsEnabled: (enabled: boolean) => void;
    onChangeReportReminder: (kind: "morning" | "evening", enabled: boolean, time: string) => void;
}> = ({ settings, onSave, onClose, onChangeIgnoredRooms, onChangeNotificationsEnabled, onChangeReportReminder }) => {
    const [tab, setTab] = useState<SettingsTab>("ai");
    const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
    const [apiKey, setApiKey] = useState(settings.apiKey);
    const [model, setModel] = useState(settings.model);
    const [outputStyle, setOutputStyle] = useState(settings.outputStyle ?? "");
    const [outputTemplates, setOutputTemplates] = useState<Partial<Record<NivrisTemplateKey, string>>>(
        settings.outputTemplates ?? {},
    );
    const [messageCount, setMessageCount] = useState<number | null>(null);
    const [storageBytes, setStorageBytes] = useState<number | null>(null);
    const [cleared, setCleared] = useState(false);
    const [roomSearch, setRoomSearch] = useState("");
    const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">(
        typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    );
    const [scanningNow, setScanningNow] = useState(false);
    const [scanResult, setScanResult] = useState<string[] | null>(null);
    const [installedSha, setInstalledSha] = useState<string | null | "loading">("loading");
    const [logPathCopied, setLogPathCopied] = useState(false);
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [updateCheckResult, setUpdateCheckResult] = useState<string | null>(null);
    // Notes for the version you'd be installing, shown only once a check actually finds one —
    // the same shape as an OS update screen, rather than a changelog that's always on screen.
    const [availableRelease, setAvailableRelease] = useState<NivrisAvailableRelease | null>(null);

    useEffect(() => {
        void getInstalledSha().then(setInstalledSha);
    }, []);

    const checkForUpdateNow = async (): Promise<void> => {
        setCheckingUpdate(true);
        setUpdateCheckResult(null);
        try {
            const state = await getUpdateState(true);
            setAvailableRelease(state.kind === "new-version" ? getCachedAvailableRelease() : null);
            setUpdateCheckResult(
                state.kind === "up-to-date"
                    ? "Đã ở bản mới nhất."
                    : state.kind === "new-version"
                      ? "Có bản mới — bấm nút Cập nhật ở góc dưới màn hình."
                      : state.kind === "patch-missing"
                        ? "Element vừa tự cập nhật và gỡ N.I.V.R.I.S. — bấm nút Cài lại ở góc dưới màn hình."
                        : "Không kết nối được tới helper cập nhật nền. Cần chạy lại nivris-install một lần để bật tính năng tự cập nhật.",
            );
        } finally {
            setCheckingUpdate(false);
        }
    };

    const scanNow = async (): Promise<void> => {
        setScanningNow(true);
        setScanResult(null);
        try {
            const missing = await runReportReminderCheckNow();
            setScanResult(missing.map((t) => t.label));
        } finally {
            setScanningNow(false);
        }
    };

    const ignoredRoomIds = settings.ignoredRoomIds ?? [];
    const notificationsEnabled = settings.notificationsEnabled ?? true;

    const requestNotifPermission = (): void => {
        void Notification.requestPermission().then(setNotifPermission);
    };
    const allRooms = getMatrixClient()
        .getRooms()
        .filter((r) => r.getMyMembership() === "join")
        .sort((a, b) => (a.name || a.roomId).localeCompare(b.name || b.roomId));
    const filteredRooms = allRooms.filter((r) => (r.name || r.roomId).toLowerCase().includes(roomSearch.trim().toLowerCase()));

    const toggleIgnored = (roomId: string): void => {
        const next = ignoredRoomIds.includes(roomId)
            ? ignoredRoomIds.filter((id) => id !== roomId)
            : [...ignoredRoomIds, roomId];
        onChangeIgnoredRooms(next);
    };

    const refreshStorage = (): void => {
        void getMessagesSince(0).then((msgs) => {
            setMessageCount(msgs.length);
            setStorageBytes(new TextEncoder().encode(JSON.stringify(msgs)).length);
        });
    };

    useEffect(refreshStorage, []);

    // Escape closes, like every other dialog in Element.
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    // Every tab writes through on change — the AI tab's text fields just do it on a debounce so a
    // save isn't fired per keystroke. No save button anywhere, which is also why nothing in this
    // dialog can be "lost by closing it".
    const templatesChanged = NIVRIS_TEMPLATE_META.some(
        (m) => (outputTemplates[m.key] ?? "") !== (settings.outputTemplates?.[m.key] ?? ""),
    );
    const dirty =
        baseUrl !== settings.baseUrl ||
        apiKey !== settings.apiKey ||
        model !== settings.model ||
        outputStyle !== (settings.outputStyle ?? "") ||
        templatesChanged;

    useEffect(() => {
        if (!dirty) return;
        const id = window.setTimeout(
            () => onSave({ ...settings, baseUrl, apiKey, model, outputStyle, outputTemplates }),
            600,
        );
        return () => window.clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dirty, baseUrl, apiKey, model, outputStyle, outputTemplates]);

    // The autosave status only exists while something is actually happening: it appears on the
    // first edit, flips to "Đã lưu" once the write lands, then clears itself 3s later. An
    // always-on "Đã lưu tự động" is just furniture once you've read it the first time.
    const [autosaveStatus, setAutosaveStatus] = useState<"saving" | "saved" | null>(null);
    const wasDirty = useRef(false);
    useEffect(() => {
        if (dirty) {
            setAutosaveStatus("saving");
        } else if (wasDirty.current) {
            setAutosaveStatus("saved");
            const id = window.setTimeout(() => setAutosaveStatus(null), 3000);
            wasDirty.current = false;
            return () => window.clearTimeout(id);
        }
        wasDirty.current = dirty;
    }, [dirty]);

    const tabs: { id: SettingsTab; label: string }[] = [
        { id: "ai", label: "AI" },
        { id: "notif", label: "THÔNG BÁO" },
        { id: "data", label: "DỮ LIỆU" },
        { id: "system", label: "HỆ THỐNG" },
    ];

    return (
        // Click-outside and Escape both close; the inner stopPropagation keeps a click inside the
        // dialog from bubbling out to the backdrop and closing it mid-edit.
        <div className="mx_NivrisSettingsOverlay" onClick={onClose}>
            <div className="mx_NivrisSettingsDialog" onClick={(e) => e.stopPropagation()}>
                <div className="mx_NivrisSettingsHead">
                    <span className="mx_NivrisSettingsTitle">CÀI ĐẶT</span>
                    <button className="mx_NivrisSettingsClose" title="Đóng" onClick={onClose}>
                        <CloseIcon width="16px" height="16px" />
                    </button>
                </div>

                <div className="mx_NivrisSettingsBody">
                    <nav className="mx_NivrisSettingsTabs">
                        {tabs.map((t) => (
                            <button
                                key={t.id}
                                className={`mx_NivrisSettingsTab ${tab === t.id ? "mx_NivrisSettingsTab_active" : ""}`}
                                onClick={() => setTab(t.id)}
                            >
                                {t.label}
                            </button>
                        ))}
                    </nav>

                    <div className="mx_NivrisSettingsPane">
                        {tab === "ai" && (
                            <div className="mx_NivrisWorkspace_settings mx_NivrisWorkspace_settings_wide">
                        {/* Kept mounted so the fields below don't jump when it comes and goes. */}
                        <div className="mx_NivrisSettingsAutosave" aria-hidden={!autosaveStatus} data-visible={!!autosaveStatus}>
                            {autosaveStatus === "saving" ? "Đang lưu…" : "Đã lưu"}
                        </div>
                        <div className="mx_NivrisWorkspace_sectionLabel">KẾT NỐI</div>

                        <div className="mx_NivrisWorkspace_settingsField">
                            <label className="mx_NivrisWorkspace_settingsLabel">MODEL</label>
                            <input className="mx_NivrisWorkspace_settingsInput" value={model} onChange={(e) => setModel(e.target.value)} />
                        </div>
                        <div className="mx_NivrisWorkspace_settingsField">
                            <label className="mx_NivrisWorkspace_settingsLabel">BASE URL</label>
                            <input className="mx_NivrisWorkspace_settingsInput" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                        </div>
                        <div className="mx_NivrisWorkspace_settingsField">
                            <label className="mx_NivrisWorkspace_settingsLabel">API KEY</label>
                            <input
                                className="mx_NivrisWorkspace_settingsInput"
                                type="password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="sk-ant-…"
                            />
                        </div>


                        <div className="mx_NivrisWorkspace_sectionLabel">ĐỊNH DẠNG ĐẦU RA</div>
                        <div className="mx_NivrisWorkspace_settingsNote">
                            Quy định đầu ra của các bản tóm tắt / tổng hợp để lần nào chạy cũng ra cùng một khuôn. Để trống ô
                            nào thì ô đó dùng mặc định. Nhớ bấm LƯU ở trên sau khi sửa.
                        </div>

                        <div className="mx_NivrisWorkspace_settingsField">
                            <div className="mx_NivrisWorkspace_settingsFieldHead">
                                <label className="mx_NivrisWorkspace_settingsLabel">VĂN PHONG CHUNG</label>
                                <button
                                    className="mx_NivrisWorkspace_settingsReset"
                                    disabled={!outputStyle}
                                    onClick={() => setOutputStyle("")}
                                >
                                    Khôi phục mặc định
                                </button>
                            </div>
                            <div className="mx_NivrisWorkspace_settingsNote">
                                Áp dụng cho cả ba mục dưới — đây là thứ giữ cho chúng đọc ra cùng một giọng.
                            </div>
                            <textarea
                                className="mx_NivrisWorkspace_settingsTextarea"
                                value={outputStyle}
                                placeholder={DEFAULT_OUTPUT_STYLE}
                                onChange={(e) => setOutputStyle(e.target.value)}
                            />
                        </div>

                        {NIVRIS_TEMPLATE_META.map((meta) => (
                            <div className="mx_NivrisWorkspace_settingsField" key={meta.key}>
                                <div className="mx_NivrisWorkspace_settingsFieldHead">
                                    <label className="mx_NivrisWorkspace_settingsLabel">{meta.label}</label>
                                    <button
                                        className="mx_NivrisWorkspace_settingsReset"
                                        disabled={!outputTemplates[meta.key]}
                                        onClick={() => setOutputTemplates((prev) => ({ ...prev, [meta.key]: "" }))}
                                    >
                                        Khôi phục mặc định
                                    </button>
                                </div>
                                <div className="mx_NivrisWorkspace_settingsNote">{meta.hint}</div>
                                <textarea
                                    className="mx_NivrisWorkspace_settingsTextarea"
                                    value={outputTemplates[meta.key] ?? ""}
                                    placeholder={DEFAULT_TEMPLATES[meta.key]}
                                    onChange={(e) => setOutputTemplates((prev) => ({ ...prev, [meta.key]: e.target.value }))}
                                />
                                {!!meta.placeholders.length && (
                                    <div className="mx_NivrisWorkspace_settingsPlaceholders">
                                        Biến thay thế: {meta.placeholders.join("  ")} — dòng nào chứa biến không có giá trị sẽ tự
                                        bị bỏ đi.
                                    </div>
                                )}
                            </div>
                        ))}
                            </div>
                        )}

                        {tab === "notif" && (
                            <div className="mx_NivrisWorkspace_settings">
                        <div>
                            <div className="mx_NivrisWorkspace_sectionLabel">THÔNG BÁO</div>
                            <label className="mx_NivrisWorkspace_roomIgnoreItem" style={{ border: "none", padding: "4px 0" }}>
                                <input
                                    type="checkbox"
                                    checked={notificationsEnabled}
                                    onChange={(e) => onChangeNotificationsEnabled(e.target.checked)}
                                />
                                <span>Báo khi có tin khớp session đang theo dõi</span>
                            </label>
                            {notifPermission === "unsupported" && (
                                <div className="mx_NivrisWorkspace_settingsSavedNote">Trình duyệt/app không hỗ trợ thông báo desktop.</div>
                            )}
                            {notifPermission === "denied" && (
                                <div className="mx_NivrisWorkspace_settingsSavedNote">
                                    Thông báo đang bị chặn ở cấp hệ thống/app — vào cài đặt thông báo của Element để bật lại.
                                </div>
                            )}
                            {notifPermission === "default" && (
                                <button className="mx_NivrisWorkspace_storageSecondaryBtn" onClick={requestNotifPermission}>
                                    CẤP QUYỀN THÔNG BÁO
                                </button>
                            )}
                        </div>


                        <div>
                            <div className="mx_NivrisWorkspace_sectionLabel">NHẮC BÁO CÔNG VIỆC</div>
                            <label className="mx_NivrisWorkspace_roomIgnoreItem" style={{ border: "none", padding: "4px 0" }}>
                                <input
                                    type="checkbox"
                                    checked={settings.morningReportReminderEnabled ?? false}
                                    onChange={(e) => onChangeReportReminder("morning", e.target.checked, settings.morningReportReminderTime ?? "09:00")}
                                />
                                <span>
                                    Nhắc đầu giờ sáng lúc{" "}
                                    <input
                                        type="time"
                                        className="mx_NivrisWorkspace_settingsInput"
                                        style={{ display: "inline-block", width: 110, height: 26, padding: "0 6px" }}
                                        value={settings.morningReportReminderTime ?? "09:00"}
                                        disabled={!settings.morningReportReminderEnabled}
                                        onChange={(e) => onChangeReportReminder("morning", settings.morningReportReminderEnabled ?? false, e.target.value)}
                                    />{" "}
                                    nếu chưa thấy tin nhắn báo việc trong ngày lên nhóm
                                </span>
                            </label>
                            <label className="mx_NivrisWorkspace_roomIgnoreItem" style={{ border: "none", padding: "4px 0" }}>
                                <input
                                    type="checkbox"
                                    checked={settings.reportReminderEnabled ?? false}
                                    onChange={(e) => onChangeReportReminder("evening", e.target.checked, settings.reportReminderTime ?? "17:30")}
                                />
                                <span>
                                    Nhắc cuối ngày lúc{" "}
                                    <input
                                        type="time"
                                        className="mx_NivrisWorkspace_settingsInput"
                                        style={{ display: "inline-block", width: 110, height: 26, padding: "0 6px" }}
                                        value={settings.reportReminderTime ?? "17:30"}
                                        disabled={!settings.reportReminderEnabled}
                                        onChange={(e) => onChangeReportReminder("evening", settings.reportReminderEnabled ?? false, e.target.value)}
                                    />{" "}
                                    nếu ai đó chưa có tin nhắn nào hôm nay
                                </span>
                            </label>
                            <div className="mx_NivrisWorkspace_settingsNote" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
                                Áp dụng cho những người đã tick "Đưa vào báo cáo cuối ngày" ở từng session.
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 9 }}>
                                <button className="mx_NivrisWorkspace_storageSecondaryBtn" onClick={() => void scanNow()} disabled={scanningNow}>
                                    {scanningNow ? <span className="mx_NivrisWorkspace_spinner" /> : null} QUÉT NGAY
                                </button>
                                {scanResult && (
                                    <span className="mx_NivrisWorkspace_settingsSavedNote">
                                        {scanResult.length === 0
                                            ? "Mọi người đều đã có tin nhắn hôm nay."
                                            : `Chưa có tin nhắn: ${scanResult.join(", ")}`}
                                    </span>
                                )}
                            </div>
                        </div>

                            </div>
                        )}

                        {tab === "data" && (
                            <div className="mx_NivrisWorkspace_settings">
                        <div>
                            <div className="mx_NivrisWorkspace_settingsLabel">LƯU TRỮ CỤC BỘ</div>
                            <div className="mx_NivrisWorkspace_storageStats">
                                <div className="mx_NivrisWorkspace_homeMiniStat">
                                    <div className="mx_NivrisWorkspace_statLabel">SỐ TIN NHỚ ĐỆM</div>
                                    <div className="mx_NivrisWorkspace_homeMiniNum">{messageCount ?? "…"}</div>
                                </div>
                                <div className="mx_NivrisWorkspace_homeMiniStat">
                                    <div className="mx_NivrisWorkspace_statLabel">DUNG LƯỢNG</div>
                                    <div className="mx_NivrisWorkspace_homeMiniNum">{storageBytes === null ? "…" : formatBytes(storageBytes)}</div>
                                </div>
                            </div>
                            <div className="mx_NivrisWorkspace_storageActions">
                                <button
                                    className="mx_NivrisWorkspace_storageSecondaryBtn"
                                    onClick={async () => {
                                        await rescanToday();
                                        refreshStorage();
                                        setCleared(true);
                                        window.setTimeout(() => setCleared(false), 2500);
                                    }}
                                >
                                    QUÉT LẠI HÔM NAY
                                </button>
                                <button
                                    className="mx_NivrisWorkspace_storageSecondaryBtn"
                                    onClick={async () => {
                                        const msgs = await getMessagesSince(0);
                                        const blob = new Blob([JSON.stringify(msgs, null, 2)], { type: "application/json" });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement("a");
                                        a.href = url;
                                        a.download = `nivris-cache-${new Date().toISOString().slice(0, 10)}.json`;
                                        a.click();
                                        URL.revokeObjectURL(url);
                                    }}
                                >
                                    XUẤT JSON
                                </button>
                                <button
                                    className="mx_NivrisWorkspace_storageDangerBtn"
                                    onClick={async () => {
                                        await clearAllMessages();
                                        // Re-populate from today's room timelines (already in memory) so
                                        // trackers don't stay empty until the next restart.
                                        await rescanToday();
                                        refreshStorage();
                                        setCleared(true);
                                        window.setTimeout(() => setCleared(false), 2500);
                                    }}
                                >
                                    XOÁ CACHE
                                </button>
                                {cleared && <span className="mx_NivrisWorkspace_settingsSavedNote">Đã xoá & quét lại tin hôm nay.</span>}
                            </div>
                        </div>


                        <div>
                            <div className="mx_NivrisWorkspace_sectionLabel">PHÒNG KHÔNG LƯU TIN NHẮN</div>
                            <input
                                className="mx_NivrisWorkspace_settingsInput"
                                placeholder="Tìm phòng…"
                                value={roomSearch}
                                onChange={(e) => setRoomSearch(e.target.value)}
                                style={{ marginBottom: 8 }}
                            />
                            <div className="mx_NivrisWorkspace_roomIgnoreList">
                                {filteredRooms.map((room) => (
                                    <label key={room.roomId} className="mx_NivrisWorkspace_roomIgnoreItem">
                                        <input
                                            type="checkbox"
                                            checked={ignoredRoomIds.includes(room.roomId)}
                                            onChange={() => toggleIgnored(room.roomId)}
                                        />
                                        <span>{room.name || room.roomId}</span>
                                    </label>
                                ))}
                                {filteredRooms.length === 0 && (
                                    <div className="mx_NivrisWorkspace_settingsSavedNote">Không tìm thấy phòng nào.</div>
                                )}
                            </div>
                            <div className="mx_NivrisWorkspace_settingsNote">
                                TIN NHẮN TỪ CÁC PHÒNG ĐÃ TICK SẼ KHÔNG ĐƯỢC LƯU VÀO BỘ NHỚ ĐỆM NỮA (CHỈ ÁP DỤNG TỪ LÚC TICK TRỞ ĐI — TIN CŨ ĐÃ LƯU TRƯỚC ĐÓ VẪN CÒN, DÙNG "XOÁ CACHE" NẾU MUỐN XOÁ SẠCH).
                            </div>
                        </div>

                            </div>
                        )}

                        {tab === "system" && (
                            <div className="mx_NivrisWorkspace_settings">
                        <div>
                            <div className="mx_NivrisWorkspace_sectionLabel">CẬP NHẬT</div>
                            <div className="mx_NivrisWorkspace_settingsSavedNote">
                                Phiên bản {NIVRIS_VERSION}
                                {" · "}
                                bản dựng {installedSha === "loading" ? "…" : installedSha ? installedSha.slice(0, 7) : "không rõ"}
                            </div>
                            <div className="mx_NivrisWorkspace_storageActions">
                                <button className="mx_NivrisWorkspace_storageSecondaryBtn" disabled={checkingUpdate} onClick={checkForUpdateNow}>
                                    {checkingUpdate ? "ĐANG KIỂM TRA..." : "KIỂM TRA CẬP NHẬT NGAY"}
                                </button>
                                {updateCheckResult && <span className="mx_NivrisWorkspace_settingsSavedNote">{updateCheckResult}</span>}
                            </div>

                            {/* This module runs in Element's renderer and has no filesystem access —
                                that's the whole reason the helper exists — so it cannot show the log
                                itself. What it can do is hand over the path without anyone having to
                                type it, which matters on a machine whose keyboard is broken: copy
                                here, right-click → Paste into Explorer/Finder. */}
                            <div className="mx_NivrisWorkspace_settingsNote" style={{ marginTop: 10 }}>
                                Nhật ký cài đặt + helper:
                                <code className="mx_NivrisWorkspace_logPath">{installLogPath()}</code>
                                <button
                                    className="mx_NivrisWorkspace_settingsReset"
                                    onClick={() => {
                                        void navigator.clipboard.writeText(installLogPath());
                                        setLogPathCopied(true);
                                        window.setTimeout(() => setLogPathCopied(false), 2500);
                                    }}
                                >
                                    {logPathCopied ? "Đã chép" : "Sao chép đường dẫn"}
                                </button>
                                <br />
                                Trình cài đặt cũng có nút "Xem nhật ký" / "Sao chép nhật ký" ở hộp thoại
                                khi chạy xong — đó là cách xem nhanh nhất khi helper không chạy.
                            </div>

                            {availableRelease && (
                                <div className="mx_NivrisWorkspace_changelog">
                                    <div className="mx_NivrisWorkspace_changelogHead">
                                        <span className="mx_NivrisWorkspace_changelogVersion">
                                            {availableRelease.version ? `v${availableRelease.version}` : "Bản mới"}
                                        </span>
                                        <span className="mx_NivrisWorkspace_changelogCurrent">SẮP CÀI</span>
                                        {availableRelease.date && (
                                            <span className="mx_NivrisWorkspace_changelogDate">{availableRelease.date}</span>
                                        )}
                                    </div>
                                    {availableRelease.changes?.length ? (
                                        <ul className="mx_NivrisWorkspace_changelogList">
                                            {availableRelease.changes.map((line, i) => (
                                                <li key={i}>{line}</li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <div className="mx_NivrisWorkspace_settingsNote">
                                            Bản này không kèm mô tả thay đổi (phát hành trước khi có tính năng ghi chú
                                            bản phát hành).
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>


                        <div className="mx_NivrisWorkspace_settingsNote">
                            API KEY LƯU TRONG LOCALSTORAGE CỦA MÁY BẠN.
                            <br />
                            TIN NHẮN CHỈ RỜI MÁY KHI BẠN BẤM PHÂN TÍCH.
                        </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* One footer save for the whole dialog: the AI tab and the ĐẦU RA tab both edit
                    fields that only land on save, and splitting the button per tab made it look
                    like switching tabs would discard the other tab's edits. */}
            </div>
        </div>
    );
};

export default NivrisWorkspace;
