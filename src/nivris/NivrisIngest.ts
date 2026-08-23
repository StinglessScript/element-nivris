/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    Direction,
    EventType,
    RoomEvent,
    type IRoomTimelineData,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";

import { getMatrixClient } from "../matrixClient";
import { getMeta, putMessage, putMessages, pruneOlderThan, setMeta, type StoredNivrisMessage } from "./NivrisMessageDb";

const RETENTION_DAYS = 7;
const MAX_BACKFILL_PAGES_PER_ROOM = 10;
const MAX_BODY_LENGTH = 2000;

function localDateKey(d = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfToday(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function toRecord(event: MatrixEvent, room: Room): StoredNivrisMessage | null {
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
    };
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

    if (event.isEncrypted()) {
        await getMatrixClient().decryptEventIfNeeded(event, { emit: false });
    }

    const record = toRecord(event, room);
    if (record) await putMessage(record);
};

async function backfillToday(client: MatrixClient): Promise<void> {
    const sinceTs = startOfToday();
    const rooms = client.getRooms().filter((room) => room.getMyMembership() === "join");

    await Promise.all(
        rooms.map(async (room) => {
            let events = room.getLiveTimeline().getEvents();
            let oldestTs = events[0]?.getTs() ?? Date.now();
            let prevToken = room.getLiveTimeline().getPaginationToken(Direction.Backward);
            let pages = 0;

            while (oldestTs > sinceTs && prevToken && pages < MAX_BACKFILL_PAGES_PER_ROOM) {
                pages++;
                let res;
                try {
                    res = await client.createMessagesRequest(room.roomId, prevToken, 200, Direction.Backward);
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

            const todayEvents = events.filter((e) => e.getTs() >= sinceTs);
            const decryptable = todayEvents.filter((e) => e.isEncrypted());
            await Promise.all(decryptable.map((e) => client.decryptEventIfNeeded(e, { emit: false })));

            const records = todayEvents
                .map((e) => toRecord(e, room))
                .filter((r): r is StoredNivrisMessage => r !== null);
            await putMessages(records);
        }),
    );
}

let started = false;

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

    void pruneOlderThan(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const key = localDateKey();
    const lastBackfillDate = await getMeta("lastBackfillDate");
    if (lastBackfillDate === key) return;

    await backfillToday(client);
    await setMeta("lastBackfillDate", key);
}
