/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";

// A handful of accent colours to hash ids into — same spirit as Element's own avatar colouring,
// not pixel-identical (that helper lives in apps/web/src, outside the module API surface).
const PALETTE = ["#5d6ef5", "#2ba95f", "#d98716", "#de3f52", "#7953ef", "#bf4b9f", "#1a9caf"];

function colorFor(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(hash) % PALETTE.length];
}

interface IProps {
    name: string;
    idName: string;
    size?: string;
    className?: string;
}

const SimpleAvatar: React.FC<IProps> = ({ name, idName, size = "24px", className }): JSX.Element => (
    <div
        className={className}
        style={{
            width: size,
            height: size,
            borderRadius: "100%",
            backgroundColor: colorFor(idName),
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: `calc(${size} * 0.45)`,
            fontWeight: 600,
            flexShrink: 0,
        }}
    >
        {(name.replace(/^@/, "")[0] ?? "?").toUpperCase()}
    </div>
);

export default SimpleAvatar;
