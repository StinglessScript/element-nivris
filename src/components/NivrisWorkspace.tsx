/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useEffect, useRef, useState } from "react";
import AiIcon from "@vector-im/compound-design-tokens/assets/web/icons/ai";
import SettingsIcon from "@vector-im/compound-design-tokens/assets/web/icons/settings";
import HomeIcon from "@vector-im/compound-design-tokens/assets/web/icons/home";
import PopOutIcon from "@vector-im/compound-design-tokens/assets/web/icons/pop-out";
import UserIcon from "@vector-im/compound-design-tokens/assets/web/icons/user";
import GroupIcon from "@vector-im/compound-design-tokens/assets/web/icons/group";
import MentionIcon from "@vector-im/compound-design-tokens/assets/web/icons/mention";
import CheckIcon from "@vector-im/compound-design-tokens/assets/web/icons/check";
import ChevronRightIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-right";
import ChevronDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-down";
import FavouriteSolidIcon from "@vector-im/compound-design-tokens/assets/web/icons/favourite-solid";
import BlockIcon from "@vector-im/compound-design-tokens/assets/web/icons/block";
import DocumentIcon from "@vector-im/compound-design-tokens/assets/web/icons/document";
import DragListIcon from "@vector-im/compound-design-tokens/assets/web/icons/drag-list";

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
    extractTasksForTracker,
    generateDailyReport,
    generateTrackerInsights,
    relativeTime,
    summarizeThread,
    type HomeOverview,
    type TrackerMetrics,
} from "../nivris/computeTrackerInsights";
import NivrisTaskStore, {
    NIVRIS_TASK_STORE_CHANGE_EVENT,
    todayKey,
    type NivrisTask,
    type NivrisTaskStatus,
} from "../nivris/NivrisTaskStore";
import { ensureNivrisIngestStarted, rescanToday, runReportReminderCheckNow, startOfToday } from "../nivris/NivrisIngest";
import { getMatrixClient } from "../matrixClient";
import { clearAllMessages, getMessagesByThreadRoot, getMessagesSince, type StoredNivrisMessage } from "../nivris/NivrisMessageDb";
import NivrisEntityPicker, { type NivrisPickerEntity } from "./NivrisEntityPicker";
import { getInstalledSha, getUpdateState } from "../nivris/NivrisUpdateChecker";
import NivrisDoneStore, { NIVRIS_DONE_STORE_CHANGE_EVENT } from "../nivris/NivrisDoneStore";

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
    const [boardOpen, setBoardOpen] = useState(false);
    const [tasks, setTasks] = useState<NivrisTask[]>(NivrisTaskStore.instance.getTasksForDate(todayKey()));
    const [selectedMessage, setSelectedMessage] = useState<StoredNivrisMessage | null>(null);
    const [inspectorTab, setInspectorTab] = useState<"message" | "info" | "chat">("info");
    const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
    const [feedFilter, setFeedFilter] = useState<"open" | "done">("open");
    // Threads default open (empty = nothing collapsed) — reported live: entering a session and
    // having to click every thread open to see what's new was the wrong default. Tracks which
    // threads were explicitly collapsed instead of which were explicitly opened.
    const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(new Set());
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

        const onTasksChange = (): void => setTasks(NivrisTaskStore.instance.getTasksForDate(todayKey()));
        NivrisTaskStore.instance.on(NIVRIS_TASK_STORE_CHANGE_EVENT, onTasksChange);

        const onDoneChange = (): void => setDoneIds(NivrisDoneStore.instance.getAll());
        NivrisDoneStore.instance.on(NIVRIS_DONE_STORE_CHANGE_EVENT, onDoneChange);

        return () => {
            NivrisTrackerStore.instance.off(NIVRIS_TRACKER_STORE_CHANGE_EVENT, onChange);
            NivrisTaskStore.instance.off(NIVRIS_TASK_STORE_CHANGE_EVENT, onTasksChange);
            NivrisDoneStore.instance.off(NIVRIS_DONE_STORE_CHANGE_EVENT, onDoneChange);
        };
    }, []);

    useEffect(() => {
        setSelectedMessage(null);
        setInspectorTab("info");
        setSummaryOpen(false);
        setFeedFilter("open");
        setCollapsedThreads(new Set());
    }, [activeId]);

    // Recomputed whenever the tracker list changes AND on a short poll, since new messages land in
    // the cache via live ingest/backfill independently of any tracker being added/removed — without
    // the poll, counts only ever refreshed if you removed and re-added a session.
    useEffect(() => {
        let cancelled = false;
        const refresh = async (): Promise<void> => {
            // Shared across every tracker so N trackers cost 1 IndexedDB scan per tick, not N.
            const todayMessages = await getMessagesSince(startOfToday());
            const entries = await Promise.all(
                trackers.map(async (t) => [t.id, await computeTrackerMetrics(t, todayMessages)] as const),
            );
            if (!cancelled) setMetricsMap(Object.fromEntries(entries));
        };
        void refresh();
        const intervalId = window.setInterval(() => void refresh(), 10_000);
        return () => {
            cancelled = true;
            window.clearInterval(intervalId);
        };
    }, [trackers]);

    const activeTracker = trackers.find((t) => t.id === activeId) ?? null;
    const activeMetrics = activeTracker ? metricsMap[activeTracker.id] : undefined;

    // Keep the room-tab selection valid as metrics load in/change (default to the busiest room).
    useEffect(() => {
        const groups = activeMetrics?.feedGroups ?? [];
        if (!groups.some((g) => g.roomId === activeRoomId)) {
            setActiveRoomId(groups[0]?.roomId ?? null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeMetrics]);

    const activeFeedGroup = activeMetrics?.feedGroups.find((g) => g.roomId === activeRoomId) ?? null;
    // "Đã xong" is only meaningful for the mention tracker (an @mention you've handled) — other
    // tracker types show every match unfiltered, same as before this existed.
    const isMentionTracker = activeTracker?.type === "mention";
    const visibleFeedItems = (activeFeedGroup?.items ?? []).filter((p) =>
        isMentionTracker ? doneIds.has(p.message.id) === (feedFilter === "done") : true,
    );

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
                        className={`mx_NivrisWorkspace_iconBtn ${!activeId && !settingsOpen && !reportOpen && !boardOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Về Home"
                        onClick={() => {
                            NivrisTrackerStore.instance.setActive(null);
                            setSettingsOpen(false);
                            setReportOpen(false);
                            setBoardOpen(false);
                        }}
                    >
                        <HomeIcon width="15px" height="15px" />
                    </button>
                    <button
                        className={`mx_NivrisWorkspace_iconBtn ${boardOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Bảng công việc"
                        onClick={() => {
                            setBoardOpen((v) => !v);
                            setSettingsOpen(false);
                            setReportOpen(false);
                        }}
                    >
                        <DragListIcon width="15px" height="15px" />
                    </button>
                    <button
                        className={`mx_NivrisWorkspace_iconBtn ${reportOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Báo cáo cuối ngày"
                        onClick={() => {
                            setReportOpen((v) => !v);
                            setSettingsOpen(false);
                            setBoardOpen(false);
                        }}
                    >
                        <DocumentIcon width="15px" height="15px" />
                    </button>
                    <button
                        className={`mx_NivrisWorkspace_iconBtn ${settingsOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Cài đặt"
                        onClick={() => {
                            setSettingsOpen((v) => !v);
                            setReportOpen(false);
                            setBoardOpen(false);
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
                    {boardOpen ? (
                        <TaskBoardView
                            tasks={tasks}
                            trackers={trackers}
                            metricsMap={metricsMap}
                            settings={settings}
                            onOpenSettings={() => { setBoardOpen(false); setSettingsOpen(true); }}
                        />
                    ) : reportOpen ? (
                        <ReportView trackers={trackers} metricsMap={metricsMap} settings={settings} onOpenSettings={() => { setReportOpen(false); setSettingsOpen(true); }} />
                    ) : settingsOpen ? (
                        <SettingsPanel
                            settings={settings}
                            onSave={(s) => { setSettings(s); setSettingsOpen(false); }}
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
                                                {isMentionTracker && !!activeMetrics?.feedGroups.length && (
                                                    <div className="mx_NivrisWorkspace_segmented">
                                                        <button
                                                            className={`mx_NivrisWorkspace_segmentedBtn ${feedFilter === "open" ? "mx_NivrisWorkspace_segmentedBtn_active" : ""}`}
                                                            onClick={() => setFeedFilter("open")}
                                                        >
                                                            Chưa xong
                                                        </button>
                                                        <button
                                                            className={`mx_NivrisWorkspace_segmentedBtn ${feedFilter === "done" ? "mx_NivrisWorkspace_segmentedBtn_active" : ""}`}
                                                            onClick={() => setFeedFilter("done")}
                                                        >
                                                            Đã xong
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                            {!activeMetrics || activeMetrics.feedGroups.length === 0 ? (
                                                <div className="mx_NivrisWorkspace_feedEmpty">Chưa có tin nhắn nào khớp với session này.</div>
                                            ) : (
                                                <>
                                                    {activeMetrics.feedGroups.length > 1 && (
                                                        <div className="mx_NivrisWorkspace_roomTabs">
                                                            {activeMetrics.feedGroups.map((group) => (
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
                                                    )}
                                                    <div className="mx_NivrisWorkspace_feedList">
                                                        {visibleFeedItems.length === 0 && isMentionTracker ? (
                                                            <div className="mx_NivrisWorkspace_feedEmpty">
                                                                {feedFilter === "done" ? "Chưa đánh dấu tin nào là đã xong." : "Không còn tin nào chưa xong."}
                                                            </div>
                                                        ) : (
                                                            visibleFeedItems.map((p, i) => {
                                                                const threadKey = p.threadMessages ? (p.message.threadRootId ?? p.message.id) : null;
                                                                const isExpanded = !!threadKey && !collapsedThreads.has(threadKey);
                                                                return (
                                                                    <div key={i}>
                                                                        <div
                                                                            className={`mx_NivrisWorkspace_feedRow ${p.message.id === selectedMessage?.id ? "mx_NivrisWorkspace_feedRow_active" : ""}`}
                                                                        >
                                                                            {threadKey && (
                                                                                <button
                                                                                    className="mx_NivrisWorkspace_feedExpandBtn"
                                                                                    title={isExpanded ? "Thu gọn" : `Xem ${p.threadMessages?.length} tin trong thread`}
                                                                                    onClick={() =>
                                                                                        setCollapsedThreads((prev) => {
                                                                                            const next = new Set(prev);
                                                                                            if (next.has(threadKey)) next.delete(threadKey);
                                                                                            else next.add(threadKey);
                                                                                            return next;
                                                                                        })
                                                                                    }
                                                                                >
                                                                                    {isExpanded ? <ChevronDownIcon width="13px" height="13px" /> : <ChevronRightIcon width="13px" height="13px" />}
                                                                                </button>
                                                                            )}
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
                                                                                {isMentionTracker && (
                                                                                    <button
                                                                                        className={`mx_NivrisWorkspace_feedRowAction ${doneIds.has(p.message.id) ? "mx_NivrisWorkspace_feedRowAction_active" : ""}`}
                                                                                        title={doneIds.has(p.message.id) ? "Bỏ đánh dấu đã xong" : "Đánh dấu đã xong"}
                                                                                        onClick={() => NivrisDoneStore.instance.setDone(p.message.id, !doneIds.has(p.message.id))}
                                                                                    >
                                                                                        <CheckIcon width="13px" height="13px" />
                                                                                    </button>
                                                                                )}
                                                                                <button
                                                                                    className="mx_NivrisWorkspace_feedRowAction"
                                                                                    title="Mở trong Element"
                                                                                    onClick={() => {
                                                                                        window.location.hash = `#/room/${p.message.roomId}/${p.message.id}`;
                                                                                    }}
                                                                                >
                                                                                    <PopOutIcon width="13px" height="13px" />
                                                                                </button>
                                                                            </div>
                                                                        </div>
                                                                        {isExpanded && p.threadMessages && (
                                                                            <div className="mx_NivrisWorkspace_feedSubList">
                                                                                {p.threadMessages.map((tm) => (
                                                                                    <div
                                                                                        className={`mx_NivrisWorkspace_feedSubRow ${tm.id === selectedMessage?.id ? "mx_NivrisWorkspace_feedRow_active" : ""}`}
                                                                                        key={tm.id}
                                                                                    >
                                                                                        <button
                                                                                            className="mx_NivrisWorkspace_feedRowMain"
                                                                                            onClick={() => {
                                                                                                setSelectedMessage(tm);
                                                                                                setInspectorTab("message");
                                                                                            }}
                                                                                        >
                                                                                            <div>
                                                                                                <div className="mx_NivrisWorkspace_feedTitle">
                                                                                                    {tm.senderName}: {tm.body.length > 100 ? `${tm.body.slice(0, 100)}…` : tm.body}
                                                                                                </div>
                                                                                                <div className="mx_NivrisWorkspace_feedMeta">{relativeTime(tm.ts)}</div>
                                                                                            </div>
                                                                                        </button>
                                                                                        <div className="mx_NivrisWorkspace_feedRowActions">
                                                                                            <button
                                                                                                className="mx_NivrisWorkspace_feedRowAction"
                                                                                                title="Mở trong Element"
                                                                                                onClick={() => {
                                                                                                    window.location.hash = `#/room/${tm.roomId}/${tm.id}`;
                                                                                                }}
                                                                                            >
                                                                                                <PopOutIcon width="13px" height="13px" />
                                                                                            </button>
                                                                                        </div>
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })
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

                {activeTracker && !settingsOpen && !reportOpen && !boardOpen && (
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
                                onClick={() => {
                                    window.location.hash = `#/room/${message.roomId}/${message.id}`;
                                }}
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
    metricsMap: Record<string, TrackerMetrics | undefined>;
    settings: NivrisSettings;
    onOpenSettings: () => void;
}> = ({ trackers, metricsMap, settings, onOpenSettings }) => {
    const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
    const employees = trackers.filter((t) => t.type === "boss" && t.isEmployee);

    const generateFor = async (tracker: NivrisUserTracker): Promise<void> => {
        setGeneratingIds((prev) => new Set(prev).add(tracker.id));
        try {
            const matches = metricsMap[tracker.id]?.matches ?? (await computeTrackerMetrics(tracker)).matches;
            const report = await generateDailyReport(tracker, settings, matches);
            NivrisTrackerStore.instance.setDailyReport(tracker.id, report);
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
                        disabled={!isNivrisConfigured(settings) || generatingIds.size > 0}
                    >
                        <AiIcon width="12px" height="12px" /> TẠO BÁO CÁO CHO TẤT CẢ
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

            {employees.length === 0 ? (
                <div className="mx_NivrisWorkspace_aiEmpty" style={{ marginTop: 14 }}>
                    Chưa có ai được gắn vào báo cáo. Mở 1 session "NGƯỜI" (nhân viên hoặc sếp) → tab "THÔNG TIN" → tick "Đưa vào báo cáo cuối ngày" và điền vị trí công việc để đưa vào đây.
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
                    {employees.map((t) => {
                        const generating = generatingIds.has(t.id);
                        const metrics = metricsMap[t.id];
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
                                        {metrics === undefined ? "đang tính…" : `${metrics.total} tin hôm nay`}
                                    </span>
                                    <button
                                        className="mx_NivrisWorkspace_aiCardAction"
                                        onClick={() => void generateFor(t)}
                                        disabled={generating || !isNivrisConfigured(settings) || !metrics?.total}
                                    >
                                        {generating ? <span className="mx_NivrisWorkspace_spinner" /> : <AiIcon width="12px" height="12px" />}
                                        {generating ? "ĐANG TẠO…" : t.dailyReport ? "TẠO LẠI" : "TẠO BÁO CÁO"}
                                    </button>
                                </div>
                                <div className="mx_NivrisWorkspace_aiCardBody">
                                    {t.dailyReport ? (
                                        <div className="mx_NivrisWorkspace_reportText">{t.dailyReport}</div>
                                    ) : (
                                        <div className="mx_NivrisWorkspace_aiEmpty">Chưa tạo báo cáo hôm nay.</div>
                                    )}
                                </div>
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

const TASK_COLUMNS: { status: NivrisTaskStatus; label: string }[] = [
    { status: "todo", label: "CẦN LÀM" },
    { status: "doing", label: "ĐANG LÀM" },
    { status: "done", label: "ĐÃ XONG" },
    { status: "late", label: "TRỄ" },
];

const TaskBoardView: React.FC<{
    tasks: NivrisTask[];
    trackers: NivrisUserTracker[];
    metricsMap: Record<string, TrackerMetrics | undefined>;
    settings: NivrisSettings;
    onOpenSettings: () => void;
}> = ({ tasks, trackers, metricsMap, settings, onOpenSettings }) => {
    const [scanning, setScanning] = useState(false);
    const [dragTaskId, setDragTaskId] = useState<string | null>(null);
    // Board is employee-only by request — "sếp"/quản lý go through the report screen, not the
    // task board, to keep the two from mixing.
    const employees = trackers.filter((t) => t.type === "boss" && t.isEmployee && t.jobTitle === "employee");

    const scanToday = async (): Promise<void> => {
        setScanning(true);
        try {
            for (const t of employees) {
                const matches = metricsMap[t.id]?.matches ?? (await computeTrackerMetrics(t)).matches;
                const extracted = await extractTasksForTracker(t, settings, matches);
                NivrisTaskStore.instance.addTasks(
                    extracted.map((e) => ({
                        title: e.title,
                        status: e.status,
                        link: e.link,
                        assigneeName: t.label,
                        trackerId: t.id,
                        date: todayKey(),
                    })),
                );
            }
        } finally {
            setScanning(false);
        }
    };

    return (
        <div className="mx_NivrisWorkspace_mainBody">
            <div className="mx_NivrisWorkspace_mainHead" style={{ padding: 0, border: "none" }}>
                <div>
                    <div className="mx_NivrisWorkspace_mainHeadName">
                        <span className="mx_NivrisWorkspace_mainName">Bảng công việc hôm nay</span>
                    </div>
                    <div className="mx_NivrisWorkspace_mainSource">{tasks.length} thẻ công việc</div>
                </div>
                <button
                    className="mx_NivrisWorkspace_aiCardAction"
                    onClick={() => void scanToday()}
                    disabled={scanning || !isNivrisConfigured(settings) || employees.length === 0}
                >
                    {scanning ? <span className="mx_NivrisWorkspace_spinner" /> : <AiIcon width="12px" height="12px" />}
                    {scanning ? "ĐANG QUÉT…" : "QUÉT CÔNG VIỆC HÔM NAY"}
                </button>
            </div>

            {!isNivrisConfigured(settings) && (
                <div className="mx_NivrisWorkspace_aiNotConfigured" style={{ marginTop: 14 }}>
                    <div className="mx_NivrisWorkspace_aiEmpty">Chưa cấu hình AI — cần model, base URL và API key trước khi quét được.</div>
                    <button className="mx_NivrisWorkspace_storageSecondaryBtn" onClick={onOpenSettings}>
                        MỞ CÀI ĐẶT
                    </button>
                </div>
            )}
            {isNivrisConfigured(settings) && employees.length === 0 && (
                <div className="mx_NivrisWorkspace_aiEmpty" style={{ marginTop: 14 }}>
                    Chưa có nhân viên nào để quét — bảng này chỉ lấy người có VTCV = "Nhân viên" (sếp/quản lý xem ở màn Báo cáo). Mở 1 session "NGƯỜI" → tab "THÔNG TIN" → tick "Đưa vào báo cáo cuối ngày" + chọn VTCV "Nhân viên".
                </div>
            )}

            <div className="mx_NivrisWorkspace_board">
                {TASK_COLUMNS.map((col) => (
                    <div
                        key={col.status}
                        className="mx_NivrisWorkspace_boardColumn"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            if (dragTaskId) NivrisTaskStore.instance.setStatus(dragTaskId, col.status);
                        }}
                    >
                        <div className="mx_NivrisWorkspace_boardColumnHead">
                            {col.label}
                            <span className="mx_NivrisWorkspace_boardColumnCount">
                                {tasks.filter((t) => t.status === col.status).length}
                            </span>
                        </div>
                        <div className="mx_NivrisWorkspace_boardColumnBody">
                            {tasks
                                .filter((t) => t.status === col.status)
                                .map((t) => (
                                    <div
                                        key={t.id}
                                        className="mx_NivrisWorkspace_boardCard"
                                        draggable
                                        onDragStart={() => setDragTaskId(t.id)}
                                        onDragEnd={() => setDragTaskId(null)}
                                    >
                                        <div className="mx_NivrisWorkspace_boardCardTitle">{t.title}</div>
                                        {t.link && (
                                            <a
                                                className="mx_NivrisWorkspace_boardCardLink"
                                                href={t.link}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <PopOutIcon width="11px" height="11px" /> {linkHostname(t.link)}
                                            </a>
                                        )}
                                        <div className="mx_NivrisWorkspace_boardCardFoot">
                                            <span className="mx_NivrisWorkspace_boardCardAssignee">{t.assigneeName}</span>
                                            <button
                                                className="mx_NivrisWorkspace_boardCardRemove"
                                                title="Xoá thẻ"
                                                onClick={() => NivrisTaskStore.instance.removeTask(t.id)}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SettingsPanel: React.FC<{
    settings: NivrisSettings;
    onSave: (s: NivrisSettings) => void;
    onChangeIgnoredRooms: (ignoredRoomIds: string[]) => void;
    onChangeNotificationsEnabled: (enabled: boolean) => void;
    onChangeReportReminder: (kind: "morning" | "evening", enabled: boolean, time: string) => void;
}> = ({ settings, onSave, onChangeIgnoredRooms, onChangeNotificationsEnabled, onChangeReportReminder }) => {
    const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
    const [apiKey, setApiKey] = useState(settings.apiKey);
    const [model, setModel] = useState(settings.model);
    const [saved, setSaved] = useState(false);
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
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [updateCheckResult, setUpdateCheckResult] = useState<string | null>(null);

    useEffect(() => {
        void getInstalledSha().then(setInstalledSha);
    }, []);

    const checkForUpdateNow = async (): Promise<void> => {
        setCheckingUpdate(true);
        setUpdateCheckResult(null);
        try {
            const state = await getUpdateState(true);
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

    return (
        <div className="mx_NivrisWorkspace_mainBody">
            <div className="mx_NivrisWorkspace_settings">
                <div className="mx_NivrisWorkspace_sectionLabel">CÀI ĐẶT AI</div>

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

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button
                        className="mx_NivrisWorkspace_settingsSave"
                        onClick={() => {
                            onSave({ ...settings, baseUrl, apiKey, model });
                            setSaved(true);
                        }}
                    >
                        LƯU
                    </button>
                    {saved && <span className="mx_NivrisWorkspace_settingsSavedNote">Đã lưu.</span>}
                </div>

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
                    <div className="mx_NivrisWorkspace_sectionLabel">CẬP NHẬT</div>
                    <div className="mx_NivrisWorkspace_settingsSavedNote">
                        Phiên bản đang cài: {installedSha === "loading" ? "…" : installedSha ? installedSha.slice(0, 7) : "không rõ"}
                    </div>
                    <div className="mx_NivrisWorkspace_storageActions">
                        <button className="mx_NivrisWorkspace_storageSecondaryBtn" disabled={checkingUpdate} onClick={checkForUpdateNow}>
                            {checkingUpdate ? "ĐANG KIỂM TRA..." : "KIỂM TRA CẬP NHẬT NGAY"}
                        </button>
                        {updateCheckResult && <span className="mx_NivrisWorkspace_settingsSavedNote">{updateCheckResult}</span>}
                    </div>
                </div>

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

                <div className="mx_NivrisWorkspace_settingsNote">
                    API KEY LƯU TRONG LOCALSTORAGE CỦA MÁY BẠN.
                    <br />
                    TIN NHẮN CHỈ RỜI MÁY KHI BẠN BẤM PHÂN TÍCH.
                </div>
            </div>
        </div>
    );
};

export default NivrisWorkspace;
