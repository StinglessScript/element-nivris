#!/usr/bin/env node
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Bumps package.json's version and writes the matching changelog entry in one step.
//
// These two have to move together — the publish job refuses to release when they disagree (see
// scripts/release-notes.mjs) — and doing it by hand means editing two files and typing today's
// date correctly every time. Most releases here are small, so `patch` is the default: a version
// per push is what makes "có gì mới" mean anything to someone deciding whether to update.
//
// Usage:
//   node scripts/bump-version.mjs "Sửa nút X"                  → patch (1.2.0 → 1.2.1)
//   node scripts/bump-version.mjs minor "Thêm màn hình Y"      → 1.2.1 → 1.3.0
//   node scripts/bump-version.mjs patch "Ghi chú 1" "Ghi chú 2"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const changelogPath = path.join(root, "src/nivris/changelog.json");

const KINDS = ["major", "minor", "patch"];
const args = process.argv.slice(2);
const kind = KINDS.includes(args[0]) ? args.shift() : "patch";
const changes = args.filter((a) => a.trim());

if (!changes.length) {
    console.error("Cần ít nhất 1 ghi chú thay đổi.");
    console.error('Ví dụ: node scripts/bump-version.mjs "Sửa lỗi không lưu được cài đặt"');
    process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
if ([major, minor, patch].some((n) => !Number.isInteger(n))) {
    console.error(`package.json version không đúng dạng x.y.z: ${pkg.version}`);
    process.exit(1);
}

const next =
    kind === "major" ? `${major + 1}.0.0` : kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

// Local date, matching how the app formats dates elsewhere — a UTC date would label an evening
// release in UTC+7 with tomorrow's date.
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const releases = JSON.parse(fs.readFileSync(changelogPath, "utf-8"));
if (releases.some((r) => r.version === next)) {
    console.error(`changelog.json đã có mục ${next} — sửa mục đó thay vì bump lại.`);
    process.exit(1);
}
releases.unshift({ version: next, date, changes });

pkg.version = next;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
fs.writeFileSync(changelogPath, `${JSON.stringify(releases, null, 4)}\n`);

console.log(`${pkg.version === next ? "" : "!"}v${next} (${kind}) — ${date}`);
for (const c of changes) console.log(`  - ${c}`);
console.log("\nCommit rồi push lên main để CI dựng và phát hành.");
