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

import { finish, log as logRaw } from "./lib/finish";
import { findElementResourcesDirWindows } from "./lib/find-element-windows.mjs";
import { setProgress, startProgress } from "./lib/progress-win";
import { quitElementIfRunning } from "./lib/quit-element";

// Embeds lib/index.js into the compiled binary; at runtime (compiled or not) this resolves to a
// real file path on disk (Bun extracts embedded files to a temp dir when running as a compiled
// executable). Run `npm run build` before compiling so this file exists to embed.
import builtJsPath from "../lib/index.js" with { type: "file" };

const TITLE = "Cài đặt N.I.V.R.I.S.";

function log(msg: string): void {
    logRaw("nivris-install", msg);
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
        // as a compiled executable — read the bytes out and write them ourselves instead.
        fs.writeFileSync(path.join(modulesDir, "nivris.js"), fs.readFileSync(builtJsPath));
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

    log("XONG. Tắt hẳn Element (không chỉ đóng cửa sổ) rồi mở lại để thấy N.I.V.R.I.S.");
    log("Lưu ý: Element tự cập nhật sẽ ghi đè lại webapp.asar gốc — sau mỗi lần Element tự update, chạy lại file này.");
    finish(TITLE, true);
}

main().catch((e) => {
    fail(e instanceof Error ? e.message : String(e));
});
