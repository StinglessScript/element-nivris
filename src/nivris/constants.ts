/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/** Shared between computeTrackerInsights (matching) and NivrisIngest (live notifications) —
 * kept in its own module so neither has to import the other just for this list. */
export const PRIORITY_KEYWORDS = ["gấp", "khẩn", "deadline", "ưu tiên", "asap", "urgent", "quan trọng"];

/** Fixed VTCV (vị trí công việc) options — a select instead of free text so the daily report
 * generator can pick the right report format per role (a manager's update reads differently from
 * an IC's progress report). */
export const JOB_TITLE_OPTIONS = [
    { value: "employee", label: "Nhân viên" },
    { value: "manager", label: "Quản lý / Trưởng nhóm" },
    { value: "executive", label: "Ban lãnh đạo / CEO" },
] as const;

export type JobTitleValue = (typeof JOB_TITLE_OPTIONS)[number]["value"];
