/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export interface NivrisSettings {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Room IDs whose messages should never be ingested into the local cache. */
    ignoredRoomIds: string[];
}

export const DEFAULT_NIVRIS_SETTINGS: NivrisSettings = {
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    model: "claude-sonnet-4-5",
    ignoredRoomIds: [],
};

export function isNivrisConfigured(settings: NivrisSettings): boolean {
    return Boolean(settings.baseUrl.trim() && settings.apiKey.trim() && settings.model.trim());
}
