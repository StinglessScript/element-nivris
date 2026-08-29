/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useRef, useState } from "react";

import {
    fetchUpdateProgress,
    getUpdateState,
    subscribeUpdateState,
    triggerUpdate,
    type NivrisUpdateState,
    type UpdateProgress,
} from "../nivris/NivrisUpdateChecker";

const PROGRESS_POLL_MS = 500;

type ViewState = { phase: "hidden" } | { phase: "prompt"; kind: "new-version" | "patch-missing" } | { phase: "updating"; progress: UpdateProgress } | { phase: "failed"; message: string };

// Matches the absolute node path guardPermissionError's "helper" branch (apply-update.mjs) always
// includes on its own line — used to offer a one-click clipboard copy, since a background
// LaunchAgent's own "open System Settings" attempt isn't reliable across every macOS Automation
// permission state, but copying text never needs any OS permission at all.
const NODE_PATH_RE = /^ {2}(\/.*\/(?:node|node\.exe))$/m;

function copyToClipboard(text: string): void {
    void navigator.clipboard?.writeText(text).catch(() => {
        // clipboard permission denied/unavailable — the path is still visible in the message text
    });
}

function toView(state: NivrisUpdateState): ViewState {
    if (state.kind === "new-version" || state.kind === "patch-missing") return { phase: "prompt", kind: state.kind };
    return { phase: "hidden" };
}

/**
 * Mounted globally (outside the Nivris page's own React tree, via api.createRoot in src/index.tsx)
 * so it's visible no matter where in Element the user currently is — same DOM-injection approach
 * threadPanelInjector.ts already uses, just appended to document.body instead of a specific Element
 * panel. Talks to the local update helper (NivrisUpdateChecker.ts) — never touches the filesystem
 * itself, since this component runs as ordinary sandboxed renderer JS.
 */
const NivrisUpdateBanner: React.FC = () => {
    const [view, setView] = useState<ViewState>({ phase: "hidden" });
    const pollRef = useRef<number | undefined>(undefined);
    const doneRecheckRef = useRef<number | undefined>(undefined);

    useEffect(() => {
        void getUpdateState().then((state) => setView(toView(state)));
        // A fresh check triggered elsewhere (e.g. Settings' "Kiểm tra cập nhật ngay" button) should
        // update this banner too — but never while an update is actively running/just failed here,
        // or an unrelated background re-check would silently wipe the progress/error the user is
        // looking at mid-click.
        const unsubscribe = subscribeUpdateState((state) => {
            setView((prev) => (prev.phase === "updating" || prev.phase === "failed" ? prev : toView(state)));
        });
        return () => {
            window.clearInterval(pollRef.current);
            window.clearTimeout(doneRecheckRef.current);
            unsubscribe();
        };
    }, []);

    const onUpdate = (): void => {
        setView({ phase: "updating", progress: { percent: 0, label: "Đang bắt đầu...", done: false, ok: true, message: "" } });
        void triggerUpdate();
        pollRef.current = window.setInterval(async () => {
            const progress = await fetchUpdateProgress();
            if (!progress) return;
            if (progress.done) {
                window.clearInterval(pollRef.current);
                if (progress.ok) {
                    setView({ phase: "updating", progress });
                    // A successful update quits and relaunches Element — this renderer is normally
                    // dead within a couple seconds, so nothing after this point usually even runs.
                    // But if that relaunch races or silently no-ops (seen for real: the helper
                    // reported done/ok while the old renderer just sat here forever on "Xong!"),
                    // this component would otherwise be stuck showing "Xong!" with no way out short
                    // of the user manually reloading. Force a fresh check instead — it either finds
                    // the new SHA and hides the banner (up to date now), or finds nothing changed
                    // and re-prompts, either of which beats staying frozen indefinitely.
                    doneRecheckRef.current = window.setTimeout(() => {
                        void getUpdateState(true).then((state) => setView(toView(state)));
                    }, 4000);
                } else {
                    setView({ phase: "failed", message: progress.message || "Cập nhật thất bại." });
                }
                return;
            }
            setView({ phase: "updating", progress });
        }, PROGRESS_POLL_MS);
    };

    if (view.phase === "hidden") return null;

    // Dismissing doesn't touch the underlying cached check — it just hides this one popup. The
    // next natural re-check (SHA change, throttle window, or a manual "Kiểm tra cập nhật ngay")
    // brings it back if the thing being reported is still true, same as before this existed.
    const onDismiss = (): void => setView({ phase: "hidden" });

    return (
        <div className="mx_NivrisUpdateBanner">
            {view.phase === "prompt" && (
                <>
                    <span className="mx_NivrisUpdateBanner_text">
                        {view.kind === "new-version" ? "Có bản cập nhật N.I.V.R.I.S. mới." : "Element vừa tự cập nhật và gỡ N.I.V.R.I.S."}
                    </span>
                    <button className="mx_NivrisUpdateBanner_btn" onClick={onUpdate}>
                        {view.kind === "new-version" ? "Cập nhật" : "Cài lại"}
                    </button>
                    <button className="mx_NivrisUpdateBanner_dismiss" onClick={onDismiss} aria-label="Để sau" title="Để sau">
                        ×
                    </button>
                </>
            )}
            {view.phase === "updating" && (
                <>
                    <span className="mx_NivrisWorkspace_spinner" />
                    <span className="mx_NivrisUpdateBanner_text">{view.progress.done ? "Xong! Element sẽ khởi động lại." : view.progress.label}</span>
                </>
            )}
            {view.phase === "failed" && (
                <>
                    <span className="mx_NivrisUpdateBanner_text mx_NivrisUpdateBanner_text_error">{view.message}</span>
                    {(() => {
                        const nodePath = NODE_PATH_RE.exec(view.message)?.[1];
                        return (
                            nodePath && (
                                <button className="mx_NivrisUpdateBanner_btn" onClick={() => copyToClipboard(nodePath)}>
                                    Copy đường dẫn
                                </button>
                            )
                        );
                    })()}
                    <button className="mx_NivrisUpdateBanner_btn" onClick={onUpdate}>
                        Thử lại
                    </button>
                    <button className="mx_NivrisUpdateBanner_dismiss" onClick={onDismiss} aria-label="Đóng" title="Đóng">
                        ×
                    </button>
                </>
            )}
        </div>
    );
};

export default NivrisUpdateBanner;
