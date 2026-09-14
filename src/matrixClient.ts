/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import type { EventType, MatrixClient } from "matrix-js-sdk/src/matrix";

/**
 * The public module `ClientApi` only exposes `getRoom(id)` + account data — far too little for
 * N.I.V.R.I.S. (it needs the full room list, member lists, and live timeline events). Element Web
 * has always exposed its MatrixClientPeg on `window.mxMatrixClientPeg` for rageshake/debugging
 * purposes (see apps/web/src/MatrixClientPeg.ts) — a genuine, stable global the app itself
 * maintains, not a private internal we're reaching into. We use that instead of the restricted
 * `Api.client` surface until the module API grows a richer client capability.
 */
interface MatrixClientPegGlobal {
    get(): MatrixClient;
}

declare global {
    interface Window {
        mxMatrixClientPeg?: MatrixClientPegGlobal;
    }
}

export function getMatrixClient(): MatrixClient {
    const peg = window.mxMatrixClientPeg;
    if (!peg) {
        throw new Error("window.mxMatrixClientPeg is not available — is Element Web logged in yet?");
    }
    return peg.get();
}

/**
 * Room ids the user has as direct messages, per their `m.direct` account data — the same source
 * Element's own DM list is built from. Read fresh each call so a room converted to/from a DM is
 * picked up without a restart; callers matching many messages should call once and reuse the set.
 */
export function getDirectRoomIds(client: MatrixClient = getMatrixClient()): Set<string> {
    // Literal cast rather than importing EventType as a value — see the note in NivrisIngest.ts on
    // why the matrix-js-sdk barrel is kept type-only.
    const content = client.getAccountData("m.direct" as EventType.Direct)?.getContent() as Record<string, unknown> | undefined;
    const ids = new Set<string>();
    for (const roomIds of Object.values(content ?? {})) {
        if (Array.isArray(roomIds)) for (const id of roomIds) if (typeof id === "string") ids.add(id);
    }
    return ids;
}
