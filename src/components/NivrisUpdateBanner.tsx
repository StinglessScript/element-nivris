/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useRef, useState } from "react";

import { fetchUpdateProgress, getUpdateState, triggerUpdate, type NivrisUpdateState, type UpdateProgress } from "../nivris/NivrisUpdateChecker";

const PROGRESS_POLL_MS = 500;

type ViewState = { phase: "hidden" } | { phase: "prompt"; kind: "new-version" | "patch-missing" } | { phase: "updating"; progress: UpdateProgress } | { phase: "failed"; message: string };

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

    useEffect(() => {
        void getUpdateState().then((state) => setView(toView(state)));
        return () => window.clearInterval(pollRef.current);
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
                } else {
                    setView({ phase: "failed", message: progress.message || "Cập nhật thất bại." });
                }
                return;
            }
            setView({ phase: "updating", progress });
        }, PROGRESS_POLL_MS);
    };

    if (view.phase === "hidden") return null;

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
                    <button className="mx_NivrisUpdateBanner_btn" onClick={onUpdate}>
                        Thử lại
                    </button>
                </>
            )}
        </div>
    );
};

export default NivrisUpdateBanner;
