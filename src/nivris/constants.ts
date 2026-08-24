/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/** Shared between computeTrackerInsights (matching) and NivrisIngest (live notifications) —
 * kept in its own module so neither has to import the other just for this list. */
export const PRIORITY_KEYWORDS = ["gấp", "khẩn", "deadline", "ưu tiên", "asap", "urgent", "quan trọng"];
