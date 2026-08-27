#!/usr/bin/env node
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Installs the Nivris module into an already-installed Element Desktop app (no rebuild of
// Element itself, no re-signing). Works by:
//   1. Building modules/nivris to lib/index.js.
//   2. Unpacking the app's webapp.asar into a plain webapp/ directory next to it (Element's own
//      resource loader — see element-desktop's src/electron-main.ts tryPaths() — falls back to a
//      plain "webapp" directory when "webapp.asar" doesn't exist, which sidesteps Electron's
//      asar-integrity fuse entirely; we never touch app.asar or re-sign anything).
//   3. Copying the built module to webapp/modules/nivris.js.
//   4. Adding "/modules/nivris.js" to the user's local config.json "modules" array.
//
// Usage:  node scripts/install-nivris.mjs
// Override the target app (e.g. a test copy) with:  ELEMENT_APP_PATH=/path/to/Element.app node scripts/install-nivris.mjs

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyNivrisUpdate } from "./lib/apply-update.mjs";

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function log(msg) {
    console.log(`[nivris-install] ${msg}`);
}
function fail(msg) {
    console.error(`[nivris-install][ERROR] ${msg}`);
    process.exit(1);
}

/**
 * Identifies exactly which commit is being installed, baked into the built module (see
 * vite.config.ts's `define`) so the in-app "update available" banner can compare its own version
 * against the latest on GitHub without needing anything else running locally. The common install
 * path (`npx -y -p github:.../ nivris-install`) does NOT leave a `.git` checkout behind — npm
 * materializes only the tracked files — so `git rev-parse HEAD` fails there; instead read the
 * commit npm itself resolved, recorded in the npx run's own `node_modules/.package-lock.json` next
 * to this package (keyed by this package's own directory name, not guessed — this repo also has
 * one git dependency of its own, matrix-js-sdk, so picking the wrong lockfile entry would silently
 * pin the wrong package's commit). Falls back to `git rev-parse HEAD` for a real local checkout
 * (`npm run install:live`), which has no such lockfile entry for itself.
 */
function currentGitSha() {
    try {
        const lockPath = path.join(moduleDir, "..", ".package-lock.json");
        if (fs.existsSync(lockPath)) {
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
            const resolved = lock.packages?.[`node_modules/${path.basename(moduleDir)}`]?.resolved ?? "";
            const m = /#([0-9a-f]{40})$/.exec(resolved);
            if (m) return m[1];
        }
    } catch {
        // fall through to git
    }
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: moduleDir, encoding: "utf-8" });
    return res.status === 0 ? res.stdout.trim() : "unknown";
}

async function main() {
    const sha = currentGitSha();
    log(`Phiên bản (git SHA): ${sha}`);

    try {
        await applyNivrisUpdate({ moduleDir, env: { NIVRIS_BUILD_SHA: sha }, onStatus: log });
    } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        return;
    }

    log("XONG. Tắt hẳn Element (không chỉ đóng cửa sổ) rồi mở lại để thấy N.I.V.R.I.S.");
    log("Lưu ý: Element tự cập nhật sẽ ghi đè lại webapp.asar gốc — sau mỗi lần Element tự update, chạy lại lệnh này.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
