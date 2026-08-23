/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useMemo, useState } from "react";
import RoomIcon from "@vector-im/compound-design-tokens/assets/web/icons/room";
import UserIcon from "@vector-im/compound-design-tokens/assets/web/icons/user";

import SimpleAvatar from "./SimpleAvatar";
import { getMatrixClient } from "../matrixClient";

export interface NivrisPickerEntity {
    kind: "user" | "room";
    id: string;
    name: string;
}

const MAX_RESULTS_PER_KIND = 5;

/** Strips a leading "@" (users naturally type "@name" mention-style) before substring matching. */
function normalizeQuery(query: string): string {
    return query.trim().replace(/^@+/, "").toLowerCase();
}

function collectRoomEntities(query: string): NivrisPickerEntity[] {
    const client = getMatrixClient();
    const q = normalizeQuery(query);
    return client
        .getRooms()
        .filter((room) => room.getMyMembership() === "join")
        .filter((room) => !q || room.name.toLowerCase().includes(q))
        .slice(0, MAX_RESULTS_PER_KIND)
        .map((room) => ({ kind: "room" as const, id: room.roomId, name: room.name || room.roomId }));
}

function collectUserEntities(query: string): NivrisPickerEntity[] {
    const client = getMatrixClient();
    const myUserId = client.getUserId();
    const q = normalizeQuery(query);
    const seen = new Map<string, NivrisPickerEntity>();

    for (const room of client.getRooms()) {
        if (room.getMyMembership() !== "join") continue;
        for (const member of room.getJoinedMembers()) {
            if (member.userId === myUserId || seen.has(member.userId)) continue;
            const name = member.name || member.userId;
            if (q && !name.toLowerCase().includes(q)) continue;
            seen.set(member.userId, { kind: "user", id: member.userId, name });
            if (seen.size >= MAX_RESULTS_PER_KIND) break;
        }
        if (seen.size >= MAX_RESULTS_PER_KIND) break;
    }
    return Array.from(seen.values());
}

interface IProps {
    query: string;
    onSelect: (entity: NivrisPickerEntity) => void;
}

/**
 * An inline "type to search, pick a real person or room" dropdown — similar in spirit to Element's
 * @-mention autocomplete, but sourced from every joined room (not scoped to a single room) since a
 * tracker can point at anyone/any room the user has ever seen, not just the current room's members.
 */
const NivrisEntityPicker: React.FC<IProps> = ({ query, onSelect }): JSX.Element | null => {
    const [highlighted, setHighlighted] = useState(0);

    const results = useMemo(() => {
        if (!query.trim()) return [];
        return [...collectUserEntities(query), ...collectRoomEntities(query)];
    }, [query]);

    if (results.length === 0) return null;

    return (
        <div
            className="mx_NivrisEntityPicker"
            role="listbox"
            onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHighlighted((h) => Math.min(h + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlighted((h) => Math.max(h - 1, 0));
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    onSelect(results[highlighted]);
                }
            }}
        >
            {results.map((entity, i) => (
                <div
                    key={`${entity.kind}:${entity.id}`}
                    role="option"
                    aria-selected={i === highlighted}
                    className={`mx_NivrisEntityPicker_item ${i === highlighted ? "mx_NivrisEntityPicker_item_highlighted" : ""}`}
                    onMouseEnter={() => setHighlighted(i)}
                    onMouseDown={(e) => {
                        // mousedown (not click) so this fires before the input's onBlur closes the picker
                        e.preventDefault();
                        onSelect(entity);
                    }}
                >
                    <SimpleAvatar name={entity.name} idName={entity.id} size="24px" />
                    <span className="mx_NivrisEntityPicker_name">{entity.name}</span>
                    <span className="mx_NivrisEntityPicker_kind">
                        {entity.kind === "user" ? <UserIcon width="14px" height="14px" /> : <RoomIcon width="14px" height="14px" />}
                    </span>
                </div>
            ))}
        </div>
    );
};

export default NivrisEntityPicker;
