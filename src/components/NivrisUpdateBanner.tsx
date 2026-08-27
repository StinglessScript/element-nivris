/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useState } from "react";

import { getUpdateState, INSTALL_COMMAND } from "../nivris/NivrisUpdateChecker";

function copyToClipboard(text: string): void {
    void navigator.clipboard?.writeText(text).catch(() => {
        // clipboard permission denied/unavailable — the command is still visible in the banner text
    });
}

/**
 * Mounted globally (outside the Nivris page's own React tree, via api.createRoot in src/index.tsx)
 * so it's visible no matter where in Element the user currently is — same DOM-injection approach
 * threadPanelInjector.ts already uses, just appended to document.body instead of a specific Element
 * panel. Pure notification: the module can't apply an update itself (no filesystem/process access
 * from sandboxed renderer JS), so this just tells the user to re-run the install command.
 */
const NivrisUpdateBanner: React.FC = () => {
    const [visible, setVisible] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        void getUpdateState().then((state) => setVisible(state.kind === "new-version"));
    }, []);

    if (!visible) return null;

    return (
        <div className="mx_NivrisUpdateBanner">
            <span className="mx_NivrisUpdateBanner_text">Có bản cập nhật N.I.V.R.I.S. mới — chạy lệnh sau rồi khởi động lại Element:</span>
            <code className="mx_NivrisUpdateBanner_cmd">{INSTALL_COMMAND}</code>
            <button
                className="mx_NivrisUpdateBanner_btn"
                onClick={() => {
                    copyToClipboard(INSTALL_COMMAND);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                }}
            >
                {copied ? "Đã copy!" : "Copy lệnh"}
            </button>
        </div>
    );
};

export default NivrisUpdateBanner;
