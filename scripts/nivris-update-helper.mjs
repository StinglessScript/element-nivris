#!/usr/bin/env node
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Persistent background service (started at login, lives across Element restarts), registered as
// a LaunchAgent (macOS) / Scheduled Task (Windows) / systemd --user unit (Linux) by
// install-nivris.mjs, so the in-app update banner
// (src/nivris/NivrisUpdateChecker.ts) can apply updates without ever opening a terminal. Listens
// on 127.0.0.1 only, gated by a token baked into both this helper's own config and the built
// module bundle at install time (neither side ever transmits it — see install-nivris.mjs).
//
// Two update paths:
//  - Common case: webapp/ already exists (previously patched) -> download the prebuilt nivris.js
//    from the latest GitHub Release and swap it in directly. Fast, no npm/vite/asar needed.
//  - Rare case: webapp/ is missing (Element reinstalled itself fresh, wiping the whole patch back
//    to a stock webapp.asar) -> shell out to `npx -y -p github:<repo> nivris-install`, the same
//    fully-dependency-resolved path the very first manual install uses. This standalone helper
//    directory doesn't carry its own copy of @electron/asar (only needed for that one-time
//    extraction), so it defers to npx rather than trying to bundle that dependency itself.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    applyNivrisUpdate,
    downloadFile,
    quitElementIfRunning,
    relaunchElement,
    findElementApp,
    checkWritePermission,
    canWriteToResourcesDir,
} from "./lib/apply-update.mjs";

// When run as a plain script (`node nivris-update-helper.mjs`, the install-nivris.mjs CLI path),
// import.meta.url correctly points at this file's real location on disk, right next to
// helper-config.json. When run as a `bun build --compile`d standalone binary instead (the
// standalone-installer.ts path), import.meta.url points at a virtual in-bundle path
// (file:///$bunfs/root/...) that doesn't exist on the real filesystem — the config file actually
// sits next to the compiled executable itself, i.e. process.execPath's directory, instead.
const helperDir = fileURLToPath(import.meta.url).includes("$bunfs")
    ? path.dirname(process.execPath)
    : path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(helperDir, "helper-config.json");

function log(msg) {
    console.log(`[nivris-update-helper] ${new Date().toISOString()} ${msg}`);
}

function loadConfig() {
    if (!fs.existsSync(configPath)) {
        console.error(`[nivris-update-helper] Missing config file: ${configPath}`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

// { port: number, token: string, repo: "owner/name" }
const config = loadConfig();

let progress = { percent: 0, label: "", done: true, ok: true, message: "" };
let updating = false;

function setProgress(patch) {
    progress = { ...progress, ...patch };
}

function currentSha(webappDir) {
    try {
        const versionFile = path.join(webappDir, "modules", "nivris.version.json");
        if (fs.existsSync(versionFile)) return JSON.parse(fs.readFileSync(versionFile, "utf-8")).sha ?? null;
    } catch {
        // ignore — treated the same as "unknown"
    }
    return null;
}

function readStatus() {
    try {
        const resourcesDir = findElementApp({
            fail: (msg) => {
                throw new Error(msg);
            },
        });
        const webappDir = path.join(resourcesDir, "webapp");
        const nivrisJs = path.join(webappDir, "modules", "nivris.js");
        return { patched: fs.existsSync(nivrisJs), sha: currentSha(webappDir) };
    } catch {
        return { patched: false, sha: null };
    }
}

async function runFullReinstall() {
    setProgress({ percent: 10, label: "Element vừa tự cập nhật — đang cài lại N.I.V.R.I.S...", done: false, ok: true, message: "" });

    // Fail fast on a permission problem, before ever touching Element — a doomed update has no
    // business closing an app the user is actively using.
    const resourcesDir = findElementApp({
        fail: (msg) => {
            throw new Error(msg);
        },
    });
    checkWritePermission(resourcesDir, "helper");

    await quitElementIfRunning((msg) => setProgress({ label: msg }));

    setProgress({ label: "Đang tải và cài lại (npx)..." });
    const isWin = process.platform === "win32";
    const res = spawnSync(isWin ? "npx.cmd" : "npx", ["-y", "-p", `github:${config.repo}`, "nivris-install"], { stdio: "ignore" });

    // Always relaunch, even on failure — quitElementIfRunning() above already closed it, so
    // leaving the user with no Element open at all (on top of a failed update) is much worse than
    // reopening the still-unpatched-but-working app and showing them what went wrong.
    setProgress({ label: "Đang khởi động lại Element..." });
    relaunchElement();

    if (res.status !== 0) {
        setProgress({ percent: 100, done: true, ok: false, message: "Cài lại thất bại — cần chạy tay lệnh nivris-install một lần nữa." });
        return;
    }
    setProgress({ percent: 100, done: true, ok: true, message: "Xong!" });
}

async function runFastUpdate() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nivris-update-"));
    let quit = false;
    try {
        setProgress({ percent: 5, label: "Đang kiểm tra bản mới nhất...", done: false, ok: true, message: "" });

        // Fail fast on a permission problem — before downloading anything, and well before
        // quitElementIfRunning() below, so a doomed update never has to close the app at all.
        const resourcesDir = findElementApp({
            fail: (msg) => {
                throw new Error(msg);
            },
        });
        checkWritePermission(resourcesDir, "helper");

        const versionPath = path.join(tmpDir, "nivris-version.json");
        await downloadFile(`https://github.com/${config.repo}/releases/latest/download/nivris-version.json`, versionPath);
        const { sha } = JSON.parse(fs.readFileSync(versionPath, "utf-8"));

        setProgress({ percent: 20, label: "Đang tải bản cập nhật..." });
        const jsPath = path.join(tmpDir, "nivris-module.js");
        await downloadFile(`https://github.com/${config.repo}/releases/latest/download/nivris-module.js`, jsPath);

        setProgress({ percent: 50, label: "Đang tắt Element..." });
        await quitElementIfRunning((msg) => setProgress({ label: msg }));
        quit = true;

        setProgress({ percent: 65, label: "Đang cài bản mới..." });
        const { webappDir } = await applyNivrisUpdate({
            builtJsPath: jsPath,
            realToken: config.token,
            onStatus: (msg) => setProgress({ label: msg }),
            errorContext: "helper",
        });
        fs.writeFileSync(path.join(webappDir, "modules", "nivris.version.json"), JSON.stringify({ sha }));

        setProgress({ percent: 90, label: "Đang khởi động lại Element..." });
        relaunchElement();
        setProgress({ percent: 100, done: true, ok: true, message: "Xong!" });
    } catch (e) {
        // Only Element itself was ever actually closed (the two downloads above happen before
        // quitting it) — if we got past that point, put it back regardless of what failed next.
        if (quit) relaunchElement();
        setProgress({ percent: 100, done: true, ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function handleUpdate() {
    if (updating) return;
    updating = true;
    try {
        const { patched } = readStatus();
        if (patched) {
            await runFastUpdate();
        } else {
            await runFullReinstall();
        }
    } catch (e) {
        setProgress({ percent: 100, done: true, ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
        updating = false;
    }
}

function authorized(req) {
    const token = req.headers["x-nivris-token"];
    return typeof token === "string" && token === config.token;
}

const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Headers", "X-Nivris-Token, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    // Preflight has no custom headers of its own to check — must succeed unconditionally so the
    // browser retries the real request, which IS gated by the token below.
    if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
    }

    if (!authorized(req)) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
    }

    if (req.method === "GET" && req.url === "/status") {
        const { patched, sha } = readStatus();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ helperRunning: true, patched, currentSha: sha }));
        return;
    }

    if (req.method === "POST" && req.url === "/update") {
        void handleUpdate();
        res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ status: "started" }));
        return;
    }

    if (req.method === "GET" && req.url === "/update/progress") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(progress));
        return;
    }

    // Lets install-nivris.mjs check, right at the end of the initial install (while the user is
    // already mid-setup, Terminal/Settings top of mind), whether *this exact helper process*
    // already has the write access it'll need for future updates — instead of only discovering a
    // missing grant later, mid-session, when an unrelated background update silently fails.
    if (req.method === "GET" && req.url === "/can-write") {
        const { patched } = readStatus();
        if (!patched) {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ canWrite: null }));
            return;
        }
        const resourcesDir = findElementApp({
            fail: () => {
                throw new Error("not found");
            },
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ canWrite: canWriteToResourcesDir(resourcesDir) }));
        return;
    }

    res.writeHead(404).end();
});

server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
        // Another helper instance is already listening — nothing to do, exit cleanly (not a crash,
        // so a KeepAlive-on-crash-only LaunchAgent won't loop-restart over this).
        log(`Cổng ${config.port} đã có helper khác đang chạy — thoát êm.`);
        process.exit(0);
    }
    log(`Lỗi server: ${e.message}`);
    process.exit(1);
});

server.listen(config.port, "127.0.0.1", () => {
    fs.writeFileSync(path.join(helperDir, "helper.pid"), String(process.pid));
    log(`Đang lắng nghe tại http://127.0.0.1:${config.port}`);
});
