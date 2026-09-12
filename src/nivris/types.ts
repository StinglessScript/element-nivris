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
    /** Desktop notifications when a live message matches an active tracker. */
    notificationsEnabled: boolean;
    /**
     * Two daily reminders — notify if a report-tagged person hasn't actually reported work by this
     * time of day. When an AI key is configured, "reported" is an AI classification of whether any
     * of today's messages reads as a real work report; otherwise it falls back to the coarser proxy
     * of having sent any tracked message at all. Morning is meant to catch "chưa báo việc hôm nay
     * lên nhóm", evening for the end-of-day report.
     */
    morningReportReminderEnabled: boolean;
    /** 24h "HH:mm" local time. */
    morningReportReminderTime: string;
    reportReminderEnabled: boolean;
    /** 24h "HH:mm" local time. */
    reportReminderTime: string;
    /**
     * Mark a session's messages "đã xem" the moment you open it. Off by default: the badge counts
     * messages you haven't marked, and clearing that just because a session was clicked is the
     * behaviour this replaced. On for anyone who treats opening as reading.
     */
    autoMarkSeenOnOpen?: boolean;
    /**
     * House rules applied to every generated summary/report, so the three outputs read as one
     * voice instead of three. Blank = use DEFAULT_OUTPUT_STYLE.
     */
    outputStyle: string;
    /**
     * Per-output instruction overrides (see outputTemplates.ts). A blank or missing entry falls
     * back to that output's default template, which is also how "khôi phục mặc định" works.
     * Optional on the type because settings persisted before this existed won't have it.
     */
    outputTemplates?: Partial<Record<"insights" | "thread" | "report", string>>;
}

export const DEFAULT_NIVRIS_SETTINGS: NivrisSettings = {
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    model: "claude-sonnet-4-5",
    ignoredRoomIds: [],
    notificationsEnabled: true,
    morningReportReminderEnabled: false,
    morningReportReminderTime: "09:00",
    reportReminderEnabled: false,
    reportReminderTime: "17:30",
    autoMarkSeenOnOpen: false,
    outputStyle: "",
    outputTemplates: {},
};

export function isNivrisConfigured(settings: NivrisSettings): boolean {
    return Boolean(settings.baseUrl.trim() && settings.apiKey.trim() && settings.model.trim());
}
