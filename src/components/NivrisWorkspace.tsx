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
import FavouriteSolidIcon from "@vector-im/compound-design-tokens/assets/web/icons/favourite-solid";
import BlockIcon from "@vector-im/compound-design-tokens/assets/web/icons/block";

import { useLocalStorageState } from "../useLocalStorageState";
import { DEFAULT_NIVRIS_SETTINGS, isNivrisConfigured, type NivrisSettings } from "../nivris/types";
import NivrisTrackerStore, {
    NIVRIS_TRACKER_STORE_CHANGE_EVENT,
    type NivrisTrackerType,
    type NivrisUserTracker,
} from "../nivris/NivrisTrackerStore";
import {
    computeHomeOverview,
    computeTrackerMetrics,
    generateTrackerInsights,
    type HomeOverview,
    type TrackerMetrics,
} from "../nivris/computeTrackerInsights";
import { ensureNivrisIngestStarted, rescanToday } from "../nivris/NivrisIngest";
import { getMatrixClient } from "../matrixClient";
import { clearAllMessages, getMessagesSince, type StoredNivrisMessage } from "../nivris/NivrisMessageDb";
import NivrisEntityPicker, { type NivrisPickerEntity } from "./NivrisEntityPicker";

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
    const [selectedMessage, setSelectedMessage] = useState<StoredNivrisMessage | null>(null);
    const [inspectorTab, setInspectorTab] = useState<"message" | "info">("info");
    const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        void ensureNivrisIngestStarted();
        const onChange = (): void => {
            setTrackers(NivrisTrackerStore.instance.getTrackers());
            setActiveId(NivrisTrackerStore.instance.getActiveId());
        };
        NivrisTrackerStore.instance.on(NIVRIS_TRACKER_STORE_CHANGE_EVENT, onChange);
        return () => {
            NivrisTrackerStore.instance.off(NIVRIS_TRACKER_STORE_CHANGE_EVENT, onChange);
        };
    }, []);

    useEffect(() => {
        setSelectedMessage(null);
        setInspectorTab("info");
    }, [activeId]);

    // Recomputed whenever the tracker list changes AND on a short poll, since new messages land in
    // the cache via live ingest/backfill independently of any tracker being added/removed — without
    // the poll, counts only ever refreshed if you removed and re-added a session.
    useEffect(() => {
        let cancelled = false;
        const refresh = async (): Promise<void> => {
            const entries = await Promise.all(
                trackers.map(async (t) => [t.id, await computeTrackerMetrics(t)] as const),
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
                        className={`mx_NivrisWorkspace_iconBtn ${!activeId && !settingsOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Về Home"
                        onClick={() => {
                            NivrisTrackerStore.instance.setActive(null);
                            setSettingsOpen(false);
                        }}
                    >
                        <HomeIcon width="15px" height="15px" />
                    </button>
                    <button
                        className={`mx_NivrisWorkspace_iconBtn ${settingsOpen ? "mx_NivrisWorkspace_iconBtn_active" : ""}`}
                        title="Cài đặt"
                        onClick={() => setSettingsOpen((v) => !v)}
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
                                            {!!metrics?.awaitingReply && (
                                                <span className="mx_NivrisWorkspace_sessionBadge">{metrics.awaitingReply}</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                    <div className="mx_NivrisWorkspace_sidebarFoot">
                        <i className="mx_NivrisWorkspace_liveDot" style={{ width: 5, height: 5 }} />
                        INGEST · REALTIME
                    </div>
                </aside>

                <div className="mx_NivrisWorkspace_main">
                    {settingsOpen ? (
                        <SettingsPanel
                            settings={settings}
                            onSave={(s) => { setSettings(s); setSettingsOpen(false); }}
                            onChangeIgnoredRooms={(ignoredRoomIds) => setSettings({ ...settings, ignoredRoomIds })}
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
                                            <div className="mx_NivrisWorkspace_aiCardHead">
                                                <i className="mx_NivrisWorkspace_liveDot" />
                                                <span className="mx_NivrisWorkspace_aiCardTitle">TÓM TẮT AI</span>
                                                <button
                                                    className="mx_NivrisWorkspace_aiCardAction"
                                                    onClick={onAnalyze}
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
                                            {hint && !analyzing && <div className="mx_NivrisWorkspace_aiHint">{hint}</div>}
                                        </section>

                                        <section className="mx_NivrisWorkspace_feed">
                                            <div className="mx_NivrisWorkspace_sectionLabel">TIN NỔI BẬT</div>
                                            {!activeMetrics || activeMetrics.feedGroups.length === 0 ? (
                                                <div className="mx_NivrisWorkspace_feedEmpty">Chưa có tin nhắn nào khớp với session này.</div>
                                            ) : (
                                                <>
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
                                                    <div className="mx_NivrisWorkspace_feedList">
                                                        {activeFeedGroup?.items.map((p, i) => (
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
                                                                    <span className="mx_NivrisWorkspace_feedDot" style={{ backgroundColor: activeFeedGroup.color }} />
                                                                    <div>
                                                                        <div className="mx_NivrisWorkspace_feedTitle">{p.title}</div>
                                                                        <div className="mx_NivrisWorkspace_feedMeta">{p.meta}</div>
                                                                    </div>
                                                                </button>
                                                                <div className="mx_NivrisWorkspace_feedRowActions">
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
                                                        ))}
                                                    </div>
                                                </>
                                            )}
                                        </section>
                                    </>
                                )}
                            </div>
                        </>
                    )}

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
                            <div className="mx_NivrisWorkspace_quickActions">
                                <button onClick={() => onCreateFixed("mention")}>
                                    <MentionIcon width="11px" height="11px" /> @ MENTION
                                </button>
                                <button onClick={() => onCreateFixed("priority")}>
                                    <FavouriteSolidIcon width="11px" height="11px" /> ƯU TIÊN
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {activeTracker && !settingsOpen && (
                    <SessionInspector
                        tracker={activeTracker}
                        metrics={activeMetrics}
                        message={selectedMessage}
                        tab={inspectorTab}
                        onTabChange={setInspectorTab}
                        onRemoveTracker={() => NivrisTrackerStore.instance.removeTracker(activeTracker.id)}
                    />
                )}
            </div>
        </div>
    );
};

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
    tab: "message" | "info";
    onTabChange: (tab: "message" | "info") => void;
    onRemoveTracker: () => void;
}> = ({ tracker, metrics, message, tab, onTabChange, onRemoveTracker }) => {
    const inThread = !!message?.threadRootId && message.threadRootId !== message.id;

    return (
        <aside className="mx_NivrisWorkspace_inspector">
            <div className="mx_NivrisWorkspace_inspectorTabs">
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
                    THÔNG TIN SESSION
                </button>
            </div>

            {tab === "message" ? (
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

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SettingsPanel: React.FC<{
    settings: NivrisSettings;
    onSave: (s: NivrisSettings) => void;
    onChangeIgnoredRooms: (ignoredRoomIds: string[]) => void;
}> = ({ settings, onSave, onChangeIgnoredRooms }) => {
    const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
    const [apiKey, setApiKey] = useState(settings.apiKey);
    const [model, setModel] = useState(settings.model);
    const [saved, setSaved] = useState(false);
    const [messageCount, setMessageCount] = useState<number | null>(null);
    const [storageBytes, setStorageBytes] = useState<number | null>(null);
    const [cleared, setCleared] = useState(false);
    const [roomSearch, setRoomSearch] = useState("");

    const ignoredRoomIds = settings.ignoredRoomIds ?? [];
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
                            onSave({ baseUrl, apiKey, model, ignoredRoomIds });
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
