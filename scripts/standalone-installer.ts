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
        const base = path.join(process.env.LOCALAPPDATA ?? "", "Element");
        if (!process.env.LOCALAPPDATA || !fs.existsSync(base)) {
            fail(
                `Không tìm thấy ${base}.\n` +
                    "Cài Element Desktop trước, hoặc chạy lại với ELEMENT_APP_PATH=C:\\duong\\dan\\app-x.y.z",
            );
        }
        const versions = fs.readdirSync(base).filter((d) => d.startsWith("app-"));
        if (!versions.length) fail(`Không tìm thấy thư mục app-* (bản cài Squirrel) trong ${base}.`);
        versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return resourcesDirFromAppPath(path.join(base, versions[versions.length - 1]));
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
    throw e;
}

async function main(): Promise<void> {
    const resourcesDir = findElementApp();
    log(`Element resources: ${resourcesDir}`);

    const webappAsar = path.join(resourcesDir, "webapp.asar");
    const webappBackup = path.join(resourcesDir, "webapp.asar.nivris-backup");
    const webappDir = path.join(resourcesDir, "webapp");

    if (!fs.existsSync(builtJsPath)) fail("Không tìm thấy module đã build bên trong file cài đặt này.");

    try {
        if (fs.existsSync(webappDir)) {
            log("webapp/ đã tồn tại (đã cài trước đó) — chỉ cập nhật module.");
        } else if (fs.existsSync(webappAsar)) {
            log("Giải nén webapp.asar...");
            const { extractAll } = await import("@electron/asar");
            extractAll(webappAsar, webappDir);
            fs.renameSync(webappAsar, webappBackup);
            log(`Đã sao lưu webapp.asar gốc -> ${webappBackup}`);
        } else {
            fail(`Không tìm thấy webapp.asar tại ${resourcesDir} (đã cài rồi, hoặc bản Element này không dùng asar?).`);
        }

        const modulesDir = path.join(webappDir, "modules");
        fs.mkdirSync(modulesDir, { recursive: true });
        // fs.copyFileSync can't read from Bun's virtual "$bunfs" embedded-asset path when running
        // as a compiled executable — read the bytes out and write them ourselves instead.
        fs.writeFileSync(path.join(modulesDir, "nivris.js"), fs.readFileSync(builtJsPath));
        log("Đã copy nivris.js vào webapp/modules/");
    } catch (e) {
        guardPermissionError(e, resourcesDir);
    }

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
