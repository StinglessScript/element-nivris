/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import type { DialogProps } from "@element-hq/element-web-module-api";

export interface NivrisThreadSummaryDialogProps {
    /** Already-computed bullet lines — the dialog is only opened once these are ready. */
    bullets: string[];
}

/**
 * Purely a result display — all the async work (fetching the thread's messages, calling the AI)
 * happens before this is opened, so the dialog only ever appears once the summary is ready
 * instead of popping up empty/loading first.
 */
const NivrisThreadSummaryDialog: React.FC<NivrisThreadSummaryDialogProps & DialogProps<void>> = ({ bullets, onCancel }) => {
    return (
        <div style={{ padding: "4px 4px 0", width: "100%" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {bullets.map((line, i) => (
                    <div className="mx_NivrisWorkspace_aiLine" key={i}>
                        <span>—</span>
                        <span>{line}</span>
                    </div>
                ))}
            </div>
            <div style={{ marginTop: 16, textAlign: "right" }}>
                <button className="mx_NivrisWorkspace_settingsSave" onClick={onCancel}>
                    ĐÓNG
                </button>
            </div>
        </div>
    );
};

export default NivrisThreadSummaryDialog;
