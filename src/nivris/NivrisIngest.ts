/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Importing these five as VALUES from the "matrix-js-sdk/src/matrix" barrel (rather than as
// types, which are erased and free) drags in ~64% of matrix-js-sdk's source by weight into this
// module's bundle — the barrel re-exports the Room/Beacon/Poll/WebRTC models etc. alongside them,
// and none of it tree-shakes away since the package doesn't declare "sideEffects": false. Only
// MatrixError needs to stay a real import (its own file, http-api/errors.ts, is lightweight and
// we need the actual class for `instanceof`); the other four are just stable, spec-level string
// constants, inlined here instead.
import { MatrixError } from "matrix-js-sdk/src/http-api/errors";
// Type-only imports are erased entirely at build time (zero bundle cost) — safe to still pull
// these types from the barrel even though the VALUE versions of the enums below are avoided.
import type {
    Direction as DirectionT,
    EventTimeline,
    EventType as EventTypeT,
    IRoomTimelineData,
    MatrixClient,
    MatrixEvent,
    MatrixEventEvent as MatrixEventEventT,
    Room,
    RoomEvent as RoomEventT,
} from "matrix-js-sdk/src/matrix";

// Cast to the specific member's literal type (`DirectionT.Backward`), not the broader enum union
// — matrix-js-sdk's event-map overloads expect the precise member literal.
const Direction = { Backward: "b" as DirectionT.Backward };
const EventType = { RoomMessage: "m.room.message" as EventTypeT.RoomMessage };
const MatrixEventEvent = { Decrypted: "Event.decrypted" as MatrixEventEventT.Decrypted };
const RoomEvent = { Timeline: "Room.timeline" as RoomEventT.Timeline };

import { getMatrixClient } from "../matrixClient";
import {
    getMessagesSince,
    getMeta,
    putMessage,
    putMessages,
    pruneOlderThan,
    setMeta,
    type StoredNivrisMessage,
} from "./NivrisMessageDb";
import NivrisTrackerStore, { type NivrisUserTracker } from "./NivrisTrackerStore";
import { PRIORITY_KEYWORDS } from "./constants";

const RETENTION_DAYS = 7;
const MAX_BACKFILL_PAGES_PER_ROOM = 10;
const MAX_BODY_LENGTH = 2000;
const BACKFILL_ROOM_CONCURRENCY = 4;
const MAX_RATE_LIMIT_RETRIES = 3;

/** Runs `fn` over `items` with at most `limit` in flight — avoids bursting the homeserver with
 * one request per room at once, which reliably triggers M_LIMIT_EXCEEDED on larger accounts. */
async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const item = items[next++];
            await fn(item);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function localDateKey(d = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfToday(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

const SETTINGS_STORAGE_KEY = "mx_nivris_assistant_settings";

/** Reads NivrisSettings straight from localStorage — ingest runs outside React, no settings prop
 * to pass in (and pulling in useLocalStorageState's React hook here would be a layering issue). */
function readSettings(): Record<string, unknown> {
    try {
        const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function isRoomIgnored(roomId: string): boolean {
    const ignored = readSettings().ignoredRoomIds;
    return Array.isArray(ignored) && ignored.includes(roomId);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsMe(content: Record<string, unknown>, body: string, client: MatrixClient): boolean {
    const myUserId = client.getUserId();
    if (!myUserId) return false;

    const mentions = content["m.mentions"] as { user_ids?: unknown } | undefined;
    const mentionedIds = Array.isArray(mentions?.user_ids) ? mentions.user_ids : [];
    if (mentionedIds.includes(myUserId)) return true;

    // Fallback for senders/clients that don't set m.mentions: a rich-text pill links straight to
    // our mxid in formatted_body, which is unambiguous (unlike matching on a display name).
    const formattedBody = typeof content.formatted_body === "string" ? content.formatted_body : "";
    if (formattedBody.includes(`matrix.to/#/${myUserId}`)) return true;

    // Last-resort plain-text fallback: require an actual "@Name" token, not just the name
    // appearing anywhere in the sentence (e.g. "...công việc..." must not match "Công").
    const myDisplayName = client.getUser(myUserId)?.displayName;
    if (!myDisplayName) return false;
    return new RegExp(`@${escapeRegExp(myDisplayName)}\\b`, "i").test(body);
}

function toRecord(event: MatrixEvent, room: Room, client: MatrixClient): StoredNivrisMessage | null {
    if (event.getType() !== EventType.RoomMessage || event.isRedacted()) return null;

    const content = event.getContent();
    const body: string = typeof content.body === "string" ? content.body : "";
    if (!body.trim()) return null;

    const sender = event.getSender() ?? "?";
    return {
        id: event.getId()!,
        roomId: room.roomId,
        roomName: room.name || room.roomId,
        sender,
        senderName: room.getMember(sender)?.name ?? sender,
        ts: event.getTs(),
        body: body.length > MAX_BODY_LENGTH ? `${body.slice(0, MAX_BODY_LENGTH)}…` : body,
        threadRootId: event.threadRootId,
        mentionsMe: mentionsMe(content, body, client),
    };
}

/** Which tracker(s) a freshly-arrived message matches, for the desktop notification — same rules
 * as computeTrackerInsights' findMatches, but against a single new record instead of the whole
 * cache, so a notification can fire the instant a live message lands. */
function matchingTrackers(record: StoredNivrisMessage, trackers: NivrisUserTracker[]): NivrisUserTracker[] {
    const lowerBody = record.body.toLowerCase();
    return trackers.filter((t) => {
        switch (t.type) {
            case "mention":
                return record.mentionsMe;
            case "priority":
                return PRIORITY_KEYWORDS.some((k) => lowerBody.includes(k));
            case "boss":
                return t.targetId ? t.targetId === record.sender : lowerBody.includes(t.label.toLowerCase());
            case "group":
                return t.targetId
                    ? t.targetId === record.roomId
                    : record.roomName.toLowerCase().includes(t.label.toLowerCase());
        }
    });
}

function maybeNotify(record: StoredNivrisMessage, myUserId: string | null): void {
    if (record.sender === myUserId) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (readSettings().notificationsEnabled === false) return;

    const matched = matchingTrackers(record, NivrisTrackerStore.instance.getTrackers());
    if (!matched.length) return;

    const title = matched.some((t) => t.type === "mention") ? "N.I.V.R.I.S. — Bạn được nhắc tới" : `N.I.V.R.I.S. — ${record.senderName}`;
    const notification = new Notification(title, {
        body: `(${record.roomName}) ${record.senderName}: ${record.body}`,
        tag: record.id,
    });
    notification.onclick = () => NivrisTrackerStore.instance.setActive(matched[0].id);
}

// The key needed to decrypt a backfilled/live event sometimes arrives (key backup, to-device)
// after our one-shot decryptEventIfNeeded already gave up — retry once it actually decrypts,
// otherwise that message is silently missing from the cache forever.
function scheduleRetryOnDecrypt(event: MatrixEvent, room: Room, client: MatrixClient): void {
    if (!event.isDecryptionFailure()) return;
    event.once(MatrixEventEvent.Decrypted, () => {
        const record = toRecord(event, room, client);
        if (record) {
            void putMessage(record);
            maybeNotify(record, client.getUserId());
        }
    });
}

const onRoomTimeline = async (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    removed: boolean,
    data: IRoomTimelineData,
): Promise<void> => {
    if (!room || removed) return;
    // Only ingest genuinely new/live events — not history loaded via backfill/pagination.
    if (toStartOfTimeline || !data?.liveEvent) return;
    if (isRoomIgnored(room.roomId)) return;

    const client = getMatrixClient();
    if (event.isEncrypted()) {
        await client.decryptEventIfNeeded(event, { emit: false });
    }

    const record = toRecord(event, room, client);
    if (record) {
        await putMessage(record);
        maybeNotify(record, client.getUserId());
    } else {
        scheduleRetryOnDecrypt(event, room, client);
    }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Wraps createMessagesRequest with backoff-and-retry on rate limiting, instead of giving up on
 * the room (see BACKFILL_ROOM_CONCURRENCY note above for why this happens fairly often). */
async function fetchMessagesWithRetry(
    client: MatrixClient,
    roomId: string,
    fromToken: string,
): ReturnType<MatrixClient["createMessagesRequest"]> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await client.createMessagesRequest(roomId, fromToken, 200, Direction.Backward);
        } catch (e) {
            const isRateLimited = e instanceof MatrixError && e.isRateLimitError();
            if (!isRateLimited || attempt >= MAX_RATE_LIMIT_RETRIES) throw e;
            await sleep((e as MatrixError).getRetryAfterMs() ?? 1000 * 2 ** attempt);
        }
    }
}

/** Thread replies live in their own timeline (see matrix-js-sdk's Thread class) — the room's main
 * timeline only ever holds the thread's root event, never its replies. Bots/notification channels
 * that post updates as threads (common, to avoid cluttering the main room) would otherwise be
 * scanned as entirely empty. Paginated the same way as the main timeline, just per-thread. */
async function backfillThreadEvents(client: MatrixClient, room: Room, sinceTs: number): Promise<MatrixEvent[]> {
    const threads = room.getThreads();
    const perThread = await Promise.all(
        threads.map(async (thread) => {
            let events = thread.liveTimeline.getEvents();
            let oldestTs = events[0]?.getTs() ?? Date.now();
            let pages = 0;

            while (
                oldestTs > sinceTs &&
                thread.liveTimeline.getPaginationToken(Direction.Backward) &&
                pages < MAX_BACKFILL_PAGES_PER_ROOM
            ) {
                pages++;
                let more: boolean;
                try {
                    more = await paginateWithRetry(client, thread.liveTimeline);
                } catch {
                    break;
                }
                events = thread.liveTimeline.getEvents();
                oldestTs = events[0]?.getTs() ?? sinceTs;
                if (!more) break;
            }
            return events;
        }),
    );
    return perThread.flat();
}

async function paginateWithRetry(client: MatrixClient, timeline: EventTimeline): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await client.paginateEventTimeline(timeline, { backwards: true, limit: 200 });
        } catch (e) {
            const isRateLimited = e instanceof MatrixError && e.isRateLimitError();
            if (!isRateLimited || attempt >= MAX_RATE_LIMIT_RETRIES) throw e;
            await sleep((e as MatrixError).getRetryAfterMs() ?? 1000 * 2 ** attempt);
        }
    }
}

async function backfillToday(client: MatrixClient): Promise<void> {
    const sinceTs = startOfToday();
    const rooms = client
        .getRooms()
        .filter((room) => room.getMyMembership() === "join" && !isRoomIgnored(room.roomId));

    await withConcurrency(rooms, BACKFILL_ROOM_CONCURRENCY, async (room) => {
        let events = room.getLiveTimeline().getEvents();
        let oldestTs = events[0]?.getTs() ?? Date.now();
        let prevToken = room.getLiveTimeline().getPaginationToken(Direction.Backward);
        let pages = 0;

        while (oldestTs > sinceTs && prevToken && pages < MAX_BACKFILL_PAGES_PER_ROOM) {
            pages++;
            let res;
            try {
                res = await fetchMessagesWithRetry(client, room.roomId, prevToken);
            } catch {
                break;
            }
            if (!res.chunk.length) break;

            const eventMapper = client.getEventMapper();
            const olderEvents = res.chunk.map(eventMapper).reverse();
            events = [...olderEvents, ...events];
            oldestTs = events[0]?.getTs() ?? sinceTs;
            prevToken = res.end ?? null;
        }

        events = [...events, ...(await backfillThreadEvents(client, room, sinceTs))];

        const todayEvents = events.filter((e) => e.getTs() >= sinceTs);
        const decryptable = todayEvents.filter((e) => e.isEncrypted());
        await Promise.all(decryptable.map((e) => client.decryptEventIfNeeded(e, { emit: false })));
        for (const e of decryptable) scheduleRetryOnDecrypt(e, room, client);

        const records = todayEvents
            .map((e) => toRecord(e, room, client))
            .filter((r): r is StoredNivrisMessage => r !== null);
        await putMessages(records);
    });
}

let started = false;

/**
 * Re-runs today's backfill on demand (e.g. right after the user clears the cache) — reads from
 * the room timelines already held in memory by the Matrix client, so it's instant and needs no
 * network round-trip for anything the client has already seen this session.
 */
export function rescanToday(): Promise<void> {
    return backfillToday(getMatrixClient());
}

const REPORT_REMINDER_CHECK_INTERVAL_MS = 60_000;

/** Employees/managers tagged for the daily report who haven't sent a single tracked message
 * today — the closest proxy we have for "chưa báo cáo công việc" without an AI call per message. */
async function findPeopleWithoutReportToday(): Promise<NivrisUserTracker[]> {
    const todayMessages = await getMessagesSince(startOfToday());
    const sendersToday = new Set(todayMessages.map((m) => m.sender));
    return NivrisTrackerStore.instance
        .getTrackers()
        .filter((t) => t.type === "boss" && t.isEmployee && t.targetId && !sendersToday.has(t.targetId));
}

interface ReportReminderConfig {
    enabledKey: "morningReportReminderEnabled" | "reportReminderEnabled";
    timeKey: "morningReportReminderTime" | "reportReminderTime";
    metaKey: string;
    title: string;
}

const REPORT_REMINDERS: ReportReminderConfig[] = [
    {
        enabledKey: "morningReportReminderEnabled",
        timeKey: "morningReportReminderTime",
        metaKey: "lastMorningReportReminderDate",
        title: "N.I.V.R.I.S. — Nhắc báo việc đầu ngày",
    },
    {
        enabledKey: "reportReminderEnabled",
        timeKey: "reportReminderTime",
        metaKey: "lastReportReminderDate",
        title: "N.I.V.R.I.S. — Nhắc báo cáo cuối ngày",
    },
];

async function checkReportReminder(config: ReportReminderConfig): Promise<void> {
    const settings = readSettings();
    if (settings[config.enabledKey] !== true) return;
    const reminderTime = typeof settings[config.timeKey] === "string" ? (settings[config.timeKey] as string) : "";
    if (!/^\d{2}:\d{2}$/.test(reminderTime)) return;

    const now = new Date();
    const nowHHmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (nowHHmm < reminderTime) return;

    const key = localDateKey();
    if ((await getMeta(config.metaKey)) === key) return;
    await setMeta(config.metaKey, key);

    const missing = await findPeopleWithoutReportToday();
    if (!missing.length) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    new Notification(config.title, {
        body: `${missing.length} người chưa thấy tin nhắn hôm nay: ${missing.map((t) => t.label).join(", ")}`,
        tag: `nivris-report-reminder-${config.metaKey}`,
    });
}

/** Checks once a minute whether it's past either configured reminder time (morning/evening) and,
 * if so, notifies once per day per reminder about anyone tagged for the report who hasn't sent a
 * tracked message yet. */
function startReportReminderScheduler(): void {
    window.setInterval(() => {
        for (const config of REPORT_REMINDERS) void checkReportReminder(config);
    }, REPORT_REMINDER_CHECK_INTERVAL_MS);
}

/** Manual "quét ngay" trigger — runs the same missing-report check right now, ignoring both the
 * configured time-of-day and the once-per-day gate, and always fires a notification if there's
 * anyone missing (regardless of the scheduled reminders' own dedup state). Also returns the list
 * directly so the Settings UI can show the result inline instead of relying on the OS notification. */
export async function runReportReminderCheckNow(): Promise<NivrisUserTracker[]> {
    const missing = await findPeopleWithoutReportToday();
    if (missing.length && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("N.I.V.R.I.S. — Quét nhanh báo công việc", {
            body: `${missing.length} người chưa thấy tin nhắn hôm nay: ${missing.map((t) => t.label).join(", ")}`,
            tag: "nivris-report-reminder-manual",
        });
    }
    return missing;
}

/**
 * Starts live ingestion of new messages into the local Nivris message cache (IndexedDB), and
 * performs a one-time-per-day backfill of today's history so the cache is complete even for
 * messages received before this session started listening. Safe to call multiple times.
 */
export async function ensureNivrisIngestStarted(): Promise<void> {
    if (started) return;
    started = true;

    const client = getMatrixClient();
    client.on(RoomEvent.Timeline, onRoomTimeline);

    if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission();
    }

    startReportReminderScheduler();

    void pruneOlderThan(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const key = localDateKey();
    const lastBackfillDate = await getMeta("lastBackfillDate");
    if (lastBackfillDate === key) return;

    await backfillToday(client);
    await setMeta("lastBackfillDate", key);
}
