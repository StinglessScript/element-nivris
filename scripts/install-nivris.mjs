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
//   5. Installing + starting a small background update-helper service (see
//      scripts/nivris-update-helper.mjs) so future updates can be applied from the in-app banner
//      instead of re-running this command by hand.
//
// Usage:  node scripts/install-nivris.mjs
// Override the target app (e.g. a test copy) with:  ELEMENT_APP_PATH=/path/to/Element.app node scripts/install-nivris.mjs

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyNivrisUpdate } from "./lib/apply-update.mjs";
import { installHelperFiles, registerHelperService } from "./lib/updater-service.mjs";

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NIVRIS_REPO = "StinglessScript/element-nivris";

function log(msg) {
    console.log(`[nivris-install] ${msg}`);
}
function fail(msg) {
    console.error(`[nivris-install][ERROR] ${msg}`);
    process.exit(1);
}

/**
 * Identifies exactly which commit is being installed, for src/nivris/NivrisUpdateChecker.ts to
 * compare against later. The common install path (`npx -y -p github:.../ nivris-install`) does
 * NOT leave a `.git` checkout behind — npm materializes only the tracked files — so `git rev-parse
 * HEAD` fails there; instead read the commit npm itself resolved, recorded in the npx run's own
 * `node_modules/.package-lock.json` next to this package (keyed by this package's own directory
 * name, not guessed — this repo also has one git dependency of its own, matrix-js-sdk, so picking
 * the wrong lockfile entry would silently pin the wrong package's commit). Falls back to `git
 * rev-parse HEAD` for a real local checkout (`npm run install:live`), which has no such lockfile
 * entry for itself.
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

    // Installed/rotated before the build so the token can be baked into the bundle the build step
    // produces — the module has no filesystem access at runtime, so this is the only way it can
    // ever learn the shared secret the update helper expects.
    const { dir: helperDir, token, port } = installHelperFiles({
        scriptsDir: path.dirname(fileURLToPath(import.meta.url)),
        repo: NIVRIS_REPO,
        log,
    });

    let webappDir;
    try {
        ({ webappDir } = await applyNivrisUpdate({
            moduleDir,
            env: { NIVRIS_UPDATE_TOKEN: token, NIVRIS_UPDATE_PORT: String(port) },
            onStatus: log,
        }));
    } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        return;
    }

    fs.writeFileSync(path.join(webappDir, "modules", "nivris.version.json"), JSON.stringify({ sha }));

    registerHelperService({ nodeExec: process.execPath, helperDir, log });

    log("XONG. Tắt hẳn Element (không chỉ đóng cửa sổ) rồi mở lại để thấy N.I.V.R.I.S.");
    await checkHelperCanWriteAndWarn({ port, token, log });
}

/**
 * On macOS, "App Management" write access is granted per requesting-process, and Terminal (which
 * just successfully patched Element above) is a *different* process from the persistent background
 * helper (a plain `node` invocation run via LaunchAgent, no Terminal involved) — so a working
 * install here doesn't imply the helper can write later. Surfacing that gap now, while the user is
 * still in this same install session, beats discovering it days later via a silently-failing
 * background update the user never asked to think about.
 */
async function checkHelperCanWriteAndWarn({ port, token, log }) {
    if (process.platform !== "darwin") return;

    // The LaunchAgent was just (re)loaded — give it a moment to actually start listening.
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try {
            const res = await fetch(`http://127.0.0.1:${port}/can-write`, { headers: { "X-Nivris-Token": token } });
            if (!res.ok) continue;
            const { canWrite } = await res.json();
            if (canWrite === false) {
                log("");
                log("QUAN TRỌNG — cần thêm 1 bước, làm 1 LẦN DUY NHẤT để bật cập nhật tự động trong app sau này:");
                log(`  System Settings → Privacy & Security → App Management → bấm "+" → chọn file: ${process.execPath}`);
                log(`  rồi bật nó lên. Không làm bước này thì mọi thứ vẫn dùng được bình thường, chỉ là`);
                log(`  banner "Cập nhật" trong app sẽ không tự chạy được cho tới khi bạn làm bước trên.`);
            }
            return;
        } catch {
            // helper not listening yet — retry
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
