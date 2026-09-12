/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Semantic version of this build, baked from package.json at build time (see vite.config.ts).
 *
 * The release notes themselves are NOT bundled here. They're only ever shown for an update you
 * don't have yet, which by definition can't come from your own build — so changelog.json stays
 * build-time data that scripts/release-notes.mjs publishes into the GitHub Release body, and the
 * update screen reads it back from there (NivrisUpdateChecker.getCachedAvailableRelease).
 *
 * To ship a release: add an entry at the TOP of changelog.json and bump package.json's version in
 * the same commit. The publish job fails if the two disagree.
 */
export const NIVRIS_VERSION: string = __NIVRIS_VERSION__;
