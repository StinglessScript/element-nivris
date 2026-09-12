#!/usr/bin/env node
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Prints the newest changelog entry as the GitHub Release body.
//
// This is how release notes reach a user who is still on the OLD build: their installed bundle
// only contains the changelog as of when it was built, so "what's in the update" cannot come from
// there. The release body can — src/nivris/NivrisUpdateChecker.ts already reads this release via
// api.github.com (the one GitHub endpoint that sends CORS headers), so it gets the notes for free
// from the same request that detects the update.
//
// The machine-readable block at the end is what the app parses; the markdown above it is for
// people reading the release page on github.com.
//
// Usage:  node scripts/release-notes.mjs > notes.md

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const releases = JSON.parse(fs.readFileSync(path.join(root, "src/nivris/changelog.json"), "utf-8"));

const latest = releases[0];
if (!latest) {
    console.error("[release-notes] changelog.json is empty");
    process.exit(1);
}
if (latest.version !== version) {
    // Loud rather than silent: shipping a build labelled 1.2.0 with 1.1.0's notes is worse than
    // failing the publish, because nobody would notice until a user asked what changed.
    console.error(`[release-notes] package.json is ${version} but the newest changelog entry is ${latest.version}`);
    process.exit(1);
}

const lines = [
    `## v${latest.version} — ${latest.date}`,
    "",
    ...latest.changes.map((c) => `- ${c}`),
    "",
    "<!-- nivris-release-json",
    JSON.stringify(latest),
    "-->",
];
process.stdout.write(lines.join("\n") + "\n");
