#!/usr/bin/env bun
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Standalone, dependency-free installer for N.I.V.R.I.S. — same install logic as
// scripts/install-nivris.mjs, but compiled (via `bun build --compile`) into a single executable
// with the built module embedded, so end users don't need Node.js or npm on their machine at all.
// Rebuild with: npm run build && bun build --compile ./scripts/standalone-installer.ts --outfile <name>

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { finish, log as logRaw } from "./lib/finish";
import { findElementResourcesDirWindows } from "./lib/find-element-windows.mjs";
import { setProgress, startProgress } from "./lib/progress-win";
import { quitElementIfRunning } from "./lib/quit-element";
import { helperInstallDir, killByPidFile, registerHelperService } from "./lib/updater-service.mjs";

// Embeds lib/index.js into the compiled binary; at runtime (compiled or not) this resolves to a
// real file path on disk (Bun extracts embedded files to a temp dir when running as a compiled
// executable). Run `npm run build` before compiling so this file exists to embed.
import builtJsPath from "../lib/index.js" with { type: "file" };

// The persistent update helper needs to be a self-contained executable too (no surrounding
// `scripts/` checkout on disk, no guaranteed system Node/Bun install, for a LaunchAgent/Scheduled
// Task to later run a script *with*) — but compiling it as a *separate* `bun build --compile`
// binary and embedding those bytes here (an earlier version of this file did that) roughly doubled
// the installer's download size, since each `bun build --compile` output embeds a full copy of the
// Bun runtime. Instead, this installer just copies *itself* to become the helper (see
// installHelperFilesStandalone()) and re-execs with an internal flag — see the `--run-helper`
// check right below main()'s definition — reusing the one Bun runtime already being downloaded
// anyway rather than shipping a second one.
const RUN_HELPER_FLAG = "--run-helper";

// Baked in by `bun build --compile --define` at CI build time (see .github/workflows/release.yml)
// — this compiled binary has no git checkout to read a commit SHA from at runtime, and the module
// it embeds was built as the one shared public CI artifact (see TOKEN_PLACEHOLDER's doc comment in
// scripts/lib/apply-update.mjs), so it can't have any one user's real update token baked in either.
declare const NIVRIS_BUILD_SHA: string;
const TOKEN_PLACEHOLDER = "__NIVRIS_TOKEN_PLACEHOLDER__";
const NIVRIS_REPO = "StinglessScript/element-nivris";
const HELPER_PORT = 47291;

const TITLE = "Cài đặt N.I.V.R.I.S.";

function log(msg: string): void {
    logRaw("nivris-install", msg);
}
/** Windows won't let you overwrite a .exe file that's currently running as a live process —
 * unlike POSIX, where the old inode just stays open under the still-running process while the
 * path gets a fresh file. A previous install/test leaving the helper running (its own scheduled
 * task, or a manual `--run-helper` test session) makes a plain copyFileSync fail with EBUSY.
 * Stop whatever's holding it — by its recorded pid first, then by image name as a backstop for a
 * stale/missing pid file (e.g. a manually-run test instance never wrote one) — and give Windows a
 * moment to actually release the file handle before retrying; process exit and handle release
 * aren't quite synchronous. No-op (immediate success) when nothing was running. */
function copyExecutableReplacingRunningInstance(src: string, dest: string, helperDir: string): void {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.copyFileSync(src, dest);
            return;
        } catch (e) {
            const code = (e as { code?: string } | undefined)?.code;
            if (attempt >= 4 || (code !== "EBUSY" && code !== "EPERM")) throw e;
            killByPidFile(helperDir);
            if (process.platform === "win32") {
                try {
                    execFileSync("taskkill", ["/IM", path.basename(dest), "/F"], { stdio: "ignore" });
                } catch {
                    // wasn't running under that name either — fine, the retry below will surface
                    // whatever's actually still wrong
                }
            }
            const until = Date.now() + 400;
            const sab = new SharedArrayBuffer(4);
            Atomics.wait(new Int32Array(sab), 0, 0, Math.max(0, until - Date.now()));
        }
    }
}

/**
 * Standalone-binary equivalent of scripts/lib/updater-service.mjs's installHelperFiles() — that
 * version copies the plain-.mjs helper + its ./lib deps from a real `scripts/` checkout on disk,
 * which doesn't exist here. Copies *this installer's own compiled executable* (process.execPath)
 * to become the future helper binary instead — it gets re-invoked with the `--run-helper` flag
 * (see below), which runs the helper server logic in-process rather than the install logic. Plain
 * fs.copyFileSync (not the embedded-asset read/rewrite pattern used elsewhere in this file) works
 * fine here since process.execPath is a real on-disk path, not a virtual $bunfs one.
 */
function installHelperFilesStandalone(): { dir: string; execPath: string; token: string; port: number } {
    const dir = helperInstallDir();
    fs.mkdirSync(dir, { recursive: true });
    const execPath = path.join(dir, process.platform === "win32" ? "nivris-update-helper.exe" : "nivris-update-helper");
    copyExecutableReplacingRunningInstance(process.execPath, execPath, dir);
    if (process.platform !== "win32") fs.chmodSync(execPath, 0o755);

    const token = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(dir, "helper-config.json"), JSON.stringify({ port: HELPER_PORT, token, repo: NIVRIS_REPO }, null, 4));
    return { dir, execPath, token, port: HELPER_PORT };
}

function fail(msg: string): never {
    console.error(`[nivris-install][ERROR] ${msg}`);
    logRaw("nivris-install", `LỖI: ${msg}`);
    finish(TITLE, false);
}

function resourcesDirFromAppPath(appPath: string): string {
    return process.platform === "darwin" ? path.join(appPath, "Contents/Resources") : path.join(appPath, "resources");
}

function findElementApp(): string {
    if (process.env.ELEMENT_APP_PATH) {
        const p = process.env.ELEMENT_APP_PATH;
        if (!fs.existsSync(p)) fail(`ELEMENT_APP_PATH không tồn tại: ${p}`);
        return resourcesDirFromAppPath(p);
    }

    if (process.platform === "darwin") {
        const candidates = ["/Applications/Element.app", path.join(os.homedir(), "Applications/Element.app")];
        const found = candidates.find((p) => fs.existsSync(p));
        if (!found) {
            fail(
                "Không tìm thấy Element.app trong /Applications.\n" +
                    "Cài Element Desktop trước, hoặc chạy lại với ELEMENT_APP_PATH=/duong/dan/Element.app",
            );
        }
        return resourcesDirFromAppPath(found);
    }

    if (process.platform === "win32") {
        const found = findElementResourcesDirWindows();
        if (!found) {
            fail(
                "Không tìm thấy Element Desktop (đã thử %LOCALAPPDATA%\\Element, %LOCALAPPDATA%\\Programs\\Element,\n" +
                    "Program Files, và Windows registry).\n" +
                    "Cài Element Desktop (bản .exe thường từ element.io, không phải Microsoft Store) trước,\n" +
                    "hoặc chạy lại với ELEMENT_APP_PATH=C:\\duong\\dan\\app-x.y.z nếu bạn biết đường dẫn thật.",
            );
        }
        return found;
    }

    fail(`Chưa hỗ trợ nền tảng: ${process.platform} (bản standalone hiện chỉ có cho macOS và Windows).`);
}

function userConfigPath(): string {
    if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/Element/config.json");
    if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "Element/config.json");
    fail(`Chưa hỗ trợ nền tảng: ${process.platform}`);
}

function guardPermissionError(e: unknown, resourcesDir: string): never {
    const err = e as { code?: string } | undefined;
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        if (process.platform === "darwin") {
            fail(
                `Không có quyền ghi vào ${resourcesDir}.\n` +
                    "macOS chặn ghi vào bên trong .app trong /Applications trừ khi Terminal (hoặc app đang chạy lệnh này)\n" +
                    "được cấp quyền 'App Management':\n" +
                    "  System Settings → Privacy & Security → App Management → bật cho Terminal/app của bạn,\n" +
                    "  rồi chạy lại file này.",
            );
        }
        fail(`Không có quyền ghi vào ${resourcesDir}. Thử chạy lại với quyền Administrator.`);
    }
    if (err && err.code === "EBUSY") {
        fail(
            "Element vẫn đang chạy nên file đang bị khoá, không sửa được (đã thử tự tắt nhưng không thành công).\n" +
                (process.platform === "win32"
                    ? "Mở Task Manager, End Task mọi tiến trình 'Element', rồi chạy lại file này."
                    : "Tắt hẳn Element (Cmd+Q, không chỉ đóng cửa sổ) rồi chạy lại file này."),
        );
    }
    throw e;
}

async function main(): Promise<void> {
    startProgress(TITLE);
    setProgress(5, "Đang kiểm tra Element...");
    await quitElementIfRunning((msg) => {
        log(msg);
        setProgress(10, msg);
    });

    setProgress(15, "Đang tìm Element Desktop...");
    const resourcesDir = findElementApp();
    log(`Element resources: ${resourcesDir}`);
    setProgress(25, "Đã tìm thấy Element.");

    const webappAsar = path.join(resourcesDir, "webapp.asar");
    const webappBackup = path.join(resourcesDir, "webapp.asar.nivris-backup");
    const webappDir = path.join(resourcesDir, "webapp");

    if (!fs.existsSync(builtJsPath)) fail("Không tìm thấy module đã build bên trong file cài đặt này.");

    // Installed/rotated before the module is written so the token can be substituted into it below
    // — the module has no filesystem access at runtime, so this is the only way it can ever learn
    // the shared secret the update helper expects.
    setProgress(35, "Đang cài helper cập nhật nền...");
    const { dir: helperDir, execPath: helperExecPath, token } = installHelperFilesStandalone();

    setProgress(40, "Đang chuẩn bị webapp...");
    try {
        if (fs.existsSync(webappDir)) {
            log("webapp/ đã tồn tại (đã cài trước đó) — chỉ cập nhật module.");
            if (fs.existsSync(webappAsar)) {
                // Leftover from a previous run that got interrupted after extracting but before
                // renaming (e.g. Element was still running and locked the file) — Element prefers
                // webapp.asar over webapp/ when both exist, so this silently makes it load the
                // ORIGINAL unpatched asar instead of ours. Clean it up so the patch actually takes.
                log("webapp.asar cũ vẫn còn (có thể do lần cài trước bị gián đoạn) — dọn để Element không đọc nhầm bản gốc.");
                if (fs.existsSync(webappBackup)) {
                    fs.rmSync(webappAsar);
                } else {
                    fs.renameSync(webappAsar, webappBackup);
                }
            }
        } else if (fs.existsSync(webappAsar)) {
            log("Giải nén webapp.asar...");
            const { extractAll } = await import("@electron/asar");
            extractAll(webappAsar, webappDir);
            fs.renameSync(webappAsar, webappBackup);
            log(`Đã sao lưu webapp.asar gốc -> ${webappBackup}`);
        } else {
            fail(`Không tìm thấy webapp.asar tại ${resourcesDir} (đã cài rồi, hoặc bản Element này không dùng asar?).`);
        }

        setProgress(65, "Đang copy module...");
        const modulesDir = path.join(webappDir, "modules");
        fs.mkdirSync(modulesDir, { recursive: true });
        // fs.copyFileSync can't read from Bun's virtual "$bunfs" embedded-asset path when running
        // as a compiled executable — read the bytes out and write them ourselves instead. Also
        // text-substitutes the shared placeholder token for the real one generated above — see
        // TOKEN_PLACEHOLDER's doc comment above.
        const moduleSrc = fs.readFileSync(builtJsPath, "utf-8").split(TOKEN_PLACEHOLDER).join(token);
        fs.writeFileSync(path.join(modulesDir, "nivris.js"), moduleSrc);
        fs.writeFileSync(path.join(modulesDir, "nivris.version.json"), JSON.stringify({ sha: NIVRIS_BUILD_SHA }));
        log("Đã copy nivris.js vào webapp/modules/");
    } catch (e) {
        guardPermissionError(e, resourcesDir);
    }

    setProgress(85, "Đang cập nhật config...");
    const configPath = userConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let config: { modules?: string[] } = {};
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        } catch {
            log(`Cảnh báo: ${configPath} không parse được — sẽ ghi đè bằng config mới.`);
        }
    }
    const modules = new Set(config.modules ?? []);
    modules.add("/modules/nivris.js");
    config.modules = Array.from(modules);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    log(`Đã cập nhật config: ${configPath}`);

    registerHelperService({ execPath: helperExecPath, args: [RUN_HELPER_FLAG], helperDir, log });

    // quitElementIfRunning() at the top of main() should already have closed it, but on Windows
    // that step can silently fail to catch every process — closing the *window* isn't the same as
    // quitting (Element often just minimizes to the system tray there) — reported live from a real
    // Windows install: a leftover instance holding the old module (old shared token) made the
    // freshly-patched one look broken until it was fully killed and reopened by hand. Say so
    // explicitly rather than assuming the quit above always caught it.
    log("XONG. Kiểm tra Element đã tắt hẳn chưa (Task Manager, không còn tiến trình 'Element' nào — Windows hay ẩn nó xuống khay hệ thống thay vì thoát) rồi mở lại để thấy N.I.V.R.I.S.");
    log("Từ giờ, khi có bản mới hoặc Element tự cập nhật ghi đè lại patch, banner trong app sẽ tự cập nhật — không cần chạy lại file này nữa.");
    finish(
        TITLE,
        true,
        "Đã cài đặt N.I.V.R.I.S. thành công!\n\nKiểm tra Element đã tắt hẳn (Task Manager, không còn tiến trình 'Element' — Windows hay ẩn xuống khay hệ thống thay vì thoát), rồi mở lại để bắt đầu dùng.",
    );
}

if (process.argv.includes(RUN_HELPER_FLAG)) {
    // Re-invoked as the persistent background helper (see installHelperFilesStandalone() +
    // registerHelperService() above) — run the helper server logic instead of the installer logic.
    // A dynamic import rather than a static one so the installer's normal run never pulls in (or
    // starts) the helper's own top-level side effects (it opens an HTTP server on import).
    await import("./nivris-update-helper.mjs");
} else {
    main().catch((e) => {
        fail(e instanceof Error ? e.message : String(e));
    });
}
