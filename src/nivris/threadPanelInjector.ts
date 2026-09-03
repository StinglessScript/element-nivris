/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState } from "react";

import type { Api } from "@element-hq/element-web-module-api";
import type { Direction as DirectionT } from "matrix-js-sdk/src/matrix";
import NivrisThreadSummaryDialog from "../components/NivrisThreadSummaryDialog";
import { DEFAULT_NIVRIS_SETTINGS, isNivrisConfigured, type NivrisSettings } from "./types";
import { type StoredNivrisMessage } from "./NivrisMessageDb";
import { summarizeThread } from "./computeTrackerInsights";
import { getMatrixClient } from "../matrixClient";
import { toRecord } from "./NivrisIngest";

// Same "inline the literal instead of importing the value from the barrel" reasoning as
// NivrisIngest.ts — importing Direction as a value drags in a big slice of matrix-js-sdk's bundle.
const Direction = { Backward: "b" as DirectionT.Backward };
const THREAD_SUMMARY_MAX_PAGES = 10;

const HEADER_TITLE_SELECTOR = ".mx_ThreadView .mx_BaseCard_header_title";
const MARKER_CLASS = "mx_Nivris_threadHeaderBtnHost";

function readSettings(): NivrisSettings {
    try {
        const raw = window.localStorage.getItem("mx_nivris_assistant_settings");
        return raw ? { ...DEFAULT_NIVRIS_SETTINGS, ...JSON.parse(raw) } : DEFAULT_NIVRIS_SETTINGS;
    } catch {
        return DEFAULT_NIVRIS_SETTINGS;
    }
}

interface MatrixEventLike {
    getId(): string | undefined;
    getRoomId(): string | undefined;
}

function isMatrixEventLike(v: unknown): v is MatrixEventLike {
    return !!v && typeof (v as MatrixEventLike).getId === "function" && typeof (v as MatrixEventLike).getRoomId === "function";
}

/**
 * Element doesn't expose "which thread is currently open" to modules, and the header DOM alone
 * only has the word "Thread" — no event/room id. ThreadView (the React component whose className
 * includes `mx_ThreadView`) does have the root event as `this.props.mxEvent` though, so this walks
 * up the React fiber tree to find it. Unofficial (reaches past the public module API into React
 * internals) but the only way to identify the open thread from here.
 *
 * Must be called on a DOM node that Element's own React tree rendered (e.g. `titleEl`) — NOT on a
 * node inside our own `api.createRoot()` tree, since `fiber.return` never crosses between two
 * separate React roots.
 */
function findThreadRootEventId(domNode: Element): { id: string; roomId: string } | undefined {
    const fiberKey = Object.keys(domNode).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fiber: any = fiberKey ? (domNode as any)[fiberKey] : undefined;
    for (let i = 0; fiber && i < 200; i++) {
        const mxEvent = fiber.memoizedProps?.mxEvent;
        if (isMatrixEventLike(mxEvent)) {
            const id = mxEvent.getId();
            const roomId = mxEvent.getRoomId();
            if (id && roomId) return { id, roomId };
        }
        fiber = fiber.return;
    }
    return undefined;
}

/**
 * Reads a thread's messages straight from the Matrix SDK's in-memory thread timeline — that's the
 * single source of truth for "what's in this thread" (it's literally what the open Thread panel
 * itself is rendering right now), so there's no reason to route through NivrisIngest's separate
 * IndexedDB cache, which exists for a different feature (the report-reminder scan) and only ever
 * covers the *current* day by design — it would silently under-summarize (or, before this, report
 * "empty") any thread without activity today.
 *
 * Paginates backward first so a long thread that hasn't been fully scrolled into view still gets
 * summarized in full, not just whatever happens to be loaded from viewing it.
 */
async function readThreadMessages(roomId: string, threadRootId: string): Promise<StoredNivrisMessage[]> {
    const client = getMatrixClient();
    const room = client.getRoom(roomId);
    const thread = room?.getThread(threadRootId);
    if (!room || !thread) return [];

    for (let page = 0; page < THREAD_SUMMARY_MAX_PAGES; page++) {
        if (!thread.liveTimeline.getPaginationToken(Direction.Backward)) break;
        try {
            if (!(await client.paginateEventTimeline(thread.liveTimeline, { backwards: true, limit: 200 }))) break;
        } catch {
            break; // best-effort — summarize whatever's already loaded rather than fail the whole thing
        }
    }

    const events = thread.liveTimeline.getEvents();
    await Promise.all(events.filter((e) => e.isEncrypted()).map((e) => client.decryptEventIfNeeded(e, { emit: false })));

    return events.map((e) => toRecord(e, room, client)).filter((r): r is StoredNivrisMessage => r !== null);
}

const NivrisThreadHeaderButton: React.FC<{ api: Api; titleEl: Element }> = ({ api, titleEl }) => {
    const [state, setState] = useState<"idle" | "loading" | "error">("idle");

    const onClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
        e.stopPropagation();
        if (state === "loading") return;

        const threadRoot = findThreadRootEventId(titleEl);
        if (!threadRoot) {
            setState("error");
            window.setTimeout(() => setState("idle"), 2000);
            return;
        }

        const settings = readSettings();
        setState("loading");
        void (async () => {
            let bullets: string[];
            if (!isNivrisConfigured(settings)) {
                bullets = ["Chưa cấu hình AI — mở N.I.V.R.I.S. (icon ở thanh space) → biểu tượng cài đặt để nhập model, base URL và API key."];
            } else {
                const threadMessages = await readThreadMessages(threadRoot.roomId, threadRoot.id);
                bullets = await summarizeThread(settings, threadMessages);
            }
            setState("idle");
            api.openDialog({ title: "Tóm tắt thread — N.I.V.R.I.S." }, NivrisThreadSummaryDialog, { bullets });
        })();
    };

    return React.createElement(
        "button",
        {
            className: "mx_Nivris_threadHeaderBtn",
            title:
                state === "error"
                    ? "Không xác định được thread đang mở — thử lại"
                    : "Tóm tắt thread bằng AI — N.I.V.R.I.S.",
            "data-state": state,
            onClick,
        },
        state === "loading" ? React.createElement("span", { className: "mx_NivrisWorkspace_spinner" }) : state === "error" ? "!" : "Tóm tắt",
    );
};

/**
 * Unofficial DOM injection — the module API has no hook for the Thread side panel's own header
 * (it's a generic `BaseCard` shared by every right-panel view, with no extension point), so this
 * watches for it in the live DOM instead and mounts a button inside it directly.
 *
 * `.mx_ThreadView` / `.mx_BaseCard_header_title` are literal class names baked into Element's own
 * source (not build-hashed), so this is reasonably stable, but it's still reaching outside the
 * sanctioned module API and can break on an Element UI rework.
 */
export function startThreadPanelIconInjector(api: Api): () => void {
    const mounted = new WeakSet<Element>();

    const mountInto = (titleEl: Element): void => {
        if (mounted.has(titleEl)) return;
        mounted.add(titleEl);

        const host = document.createElement("span");
        host.className = MARKER_CLASS;
        titleEl.appendChild(host);

        api.createRoot(host).render(React.createElement(NivrisThreadHeaderButton, { api, titleEl }));
    };

    const scan = (): void => {
        document.querySelectorAll(HEADER_TITLE_SELECTOR).forEach(mountInto);
    };

    // Element's chat DOM churns constantly (new messages, read receipts, typing indicators —
    // this observer is watching the whole document.body, for the entire session, not just while
    // the Thread panel is open). Coalescing bursts into at most one scan per animation frame
    // keeps that from turning into hundreds of querySelectorAll passes per minute.
    let scanScheduled = false;
    const scheduleScan = (): void => {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            scan();
        });
    };

    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
}
