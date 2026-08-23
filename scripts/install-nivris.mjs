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
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

function log(msg) {
    console.log(`[nivris-install] ${msg}`);
}
function fail(msg) {
    console.error(`[nivris-install][ERROR] ${msg}`);
    process.exit(1);
}

function resourcesDirFromAppPath(appPath) {
    return process.platform === "darwin" ? path.join(appPath, "Contents/Resources") : path.join(appPath, "resources");
}

function findElementApp() {
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

    fail(`Chưa hỗ trợ nền tảng: ${process.platform} (chỉ macOS và Windows).`);
}

function userConfigPath() {
    if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/Element/config.json");
    if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "Element/config.json");
    fail(`Chưa hỗ trợ nền tảng: ${process.platform}`);
}

function buildModule() {
    log("Building module (vite build)...");
    const res = spawnSync(isWin ? "npx.cmd" : "npx", ["vite", "build"], { cwd: moduleDir, stdio: "inherit" });
    if (res.status !== 0) fail("Build thất bại — xem log phía trên.");
}

function guardPermissionError(e, resourcesDir) {
    if (e && (e.code === "EPERM" || e.code === "EACCES")) {
        if (process.platform === "darwin") {
            fail(
                `Không có quyền ghi vào ${resourcesDir}.\n` +
                    "macOS chặn ghi vào bên trong .app trong /Applications trừ khi Terminal (hoặc app đang chạy lệnh này)\n" +
                    "được cấp quyền 'App Management':\n" +
                    "  System Settings → Privacy & Security → App Management → bật cho Terminal/app của bạn,\n" +
                    "  rồi khởi động lại Terminal và chạy lại lệnh này.",
            );
        }
        fail(`Không có quyền ghi vào ${resourcesDir}. Thử chạy lại với quyền Administrator.`);
    }
    throw e;
}

function main() {
    const resourcesDir = findElementApp();
    log(`Element resources: ${resourcesDir}`);

    const webappAsar = path.join(resourcesDir, "webapp.asar");
    const webappBackup = path.join(resourcesDir, "webapp.asar.nivris-backup");
    const webappDir = path.join(resourcesDir, "webapp");

    buildModule();

    const builtJs = path.join(moduleDir, "lib/index.js");
    if (!fs.existsSync(builtJs)) fail("Không tìm thấy lib/index.js sau khi build.");

    try {
        if (fs.existsSync(webappDir)) {
            log("webapp/ đã tồn tại (đã cài trước đó) — chỉ cập nhật module.");
        } else if (fs.existsSync(webappAsar)) {
            log("Giải nén webapp.asar...");
            const extractRes = spawnSync(isWin ? "npx.cmd" : "npx", ["--yes", "@electron/asar", "extract", webappAsar, webappDir], {
                stdio: "inherit",
            });
            if (extractRes.status !== 0) fail("Giải nén webapp.asar thất bại.");
            fs.renameSync(webappAsar, webappBackup);
            log(`Đã sao lưu webapp.asar gốc -> ${webappBackup}`);
        } else {
            fail(`Không tìm thấy webapp.asar tại ${resourcesDir} (đã cài rồi, hoặc bản Element này không dùng asar?).`);
        }

        const modulesDir = path.join(webappDir, "modules");
        fs.mkdirSync(modulesDir, { recursive: true });
        fs.copyFileSync(builtJs, path.join(modulesDir, "nivris.js"));
        const map = `${builtJs}.map`;
        if (fs.existsSync(map)) fs.copyFileSync(map, path.join(modulesDir, "nivris.js.map"));
        log("Đã copy nivris.js vào webapp/modules/");
    } catch (e) {
        guardPermissionError(e, resourcesDir);
    }

    const configPath = userConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let config = {};
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
    log("Lưu ý: Element tự cập nhật sẽ ghi đè lại webapp.asar gốc — sau mỗi lần Element tự update, chạy lại lệnh này.");
}

main();
