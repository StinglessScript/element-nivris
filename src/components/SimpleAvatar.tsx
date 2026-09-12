/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";

// Hash ids onto Compound's decorative ramp — the same six-hue set Element tints its own avatars
// and usernames with, so a person keeps one colour across the timeline and this module. Element's
// own hashing helper lives in apps/web/src, outside the module API surface, so only the palette is
// shared, not the exact bucket a given id lands in.
const PALETTE = [1, 2, 3, 4, 5, 6].map((n) => ({
    bg: `var(--cpd-color-bg-decorative-${n})`,
    text: `var(--cpd-color-text-decorative-${n})`,
}));

function colorFor(id: string): { bg: string; text: string } {
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
            backgroundColor: colorFor(idName).bg,
            color: colorFor(idName).text,
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
