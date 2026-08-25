/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState } from "react";

import type { Api } from "@element-hq/element-web-module-api";
import NivrisThreadSummaryDialog from "../components/NivrisThreadSummaryDialog";
import { DEFAULT_NIVRIS_SETTINGS, isNivrisConfigured, type NivrisSettings } from "./types";
import { getMessagesByThreadRoot } from "./NivrisMessageDb";
import { summarizeThread } from "./computeTrackerInsights";

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
}

function isMatrixEventLike(v: unknown): v is MatrixEventLike {
    return !!v && typeof (v as MatrixEventLike).getId === "function";
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
function findThreadRootEventId(domNode: Element): string | undefined {
    const fiberKey = Object.keys(domNode).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fiber: any = fiberKey ? (domNode as any)[fiberKey] : undefined;
    for (let i = 0; fiber && i < 200; i++) {
        const mxEvent = fiber.memoizedProps?.mxEvent;
        if (isMatrixEventLike(mxEvent)) return mxEvent.getId();
        fiber = fiber.return;
    }
    return undefined;
}

const NivrisThreadHeaderButton: React.FC<{ api: Api; titleEl: Element }> = ({ api, titleEl }) => {
    const [state, setState] = useState<"idle" | "loading" | "error">("idle");

    const onClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
        e.stopPropagation();
        if (state === "loading") return;

        const threadRootId = findThreadRootEventId(titleEl);
        if (!threadRootId) {
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
                const threadMessages = await getMessagesByThreadRoot(threadRootId);
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

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
}
