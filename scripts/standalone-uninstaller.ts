#!/usr/bin/env bun
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Standalone, dependency-free uninstaller for N.I.V.R.I.S. — same logic as
// scripts/uninstall-nivris.mjs, compiled (via `bun build --compile`) into a single executable so
// end users don't need Node.js/npm on their machine.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { finish, log as logRaw } from "./lib/finish";
import { findElementResourcesDirWindows } from "./lib/find-element-windows.mjs";

const TITLE = "Gỡ N.I.V.R.I.S.";

function log(msg: string): void {
    logRaw("nivris-uninstall", msg);
}
function fail(msg: string): never {
    console.error(`[nivris-uninstall][ERROR] ${msg}`);
    logRaw("nivris-uninstall", `LỖI: ${msg}`);
    finish(TITLE, false);
}

function resourcesDirFromAppPath(appPath: string): string {
    return process.platform === "darwin" ? path.join(appPath, "Contents/Resources") : path.join(appPath, "resources");
}

function findElementApp(): string {
    if (process.env.ELEMENT_APP_PATH) return resourcesDirFromAppPath(process.env.ELEMENT_APP_PATH);

    if (process.platform === "darwin") {
        const candidates = ["/Applications/Element.app", path.join(os.homedir(), "Applications/Element.app")];
        const found = candidates.find((p) => fs.existsSync(p));
        if (!found) fail("Không tìm thấy Element.app trong /Applications.");
        return resourcesDirFromAppPath(found);
    }

    if (process.platform === "win32") {
        const found = findElementResourcesDirWindows();
        if (!found) fail("Không tìm thấy Element Desktop (đã thử các vị trí cài thường gặp và Windows registry).");
        return found;
    }

    fail(`Chưa hỗ trợ nền tảng: ${process.platform} (bản standalone hiện chỉ có cho macOS và Windows).`);
}

function userConfigPath(): string {
    if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/Element/config.json");
    if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "Element/config.json");
    fail(`Chưa hỗ trợ nền tảng: ${process.platform}`);
}

function main(): void {
    const resourcesDir = findElementApp();
    const webappDir = path.join(resourcesDir, "webapp");
    const webappBackup = path.join(resourcesDir, "webapp.asar.nivris-backup");
    const webappAsar = path.join(resourcesDir, "webapp.asar");

    if (!fs.existsSync(webappBackup)) {
        fail(`Không tìm thấy backup tại ${webappBackup} — có vẻ chưa cài Nivris vào bản Element này.`);
    }

    try {
        fs.rmSync(webappDir, { recursive: true, force: true });
        fs.renameSync(webappBackup, webappAsar);
        log(`Đã khôi phục webapp.asar gốc tại ${webappAsar}`);
    } catch (e) {
        const err = e as { code?: string } | undefined;
        if (err && (err.code === "EPERM" || err.code === "EACCES")) {
            if (process.platform === "darwin") {
                fail("Không có quyền ghi — cấp quyền 'App Management' cho ứng dụng này trong System Settings rồi thử lại.");
            }
            fail(`Không có quyền ghi vào ${resourcesDir}. Thử chạy lại với quyền Administrator.`);
        }
        if (err && err.code === "EBUSY") {
            fail(
                "Element đang chạy nên file đang bị khoá, không sửa được.\n" +
                    (process.platform === "win32"
                        ? "Element hay ẩn xuống khay hệ thống (system tray, cạnh đồng hồ) thay vì thoát hẳn khi đóng cửa sổ.\n" +
                          "Chuột phải vào icon Element trong khay hệ thống → Quit/Exit (hoặc mở Task Manager, End Task mọi\n" +
                          "tiến trình 'Element'), rồi chạy lại file này."
                        : "Tắt hẳn Element (Cmd+Q, không chỉ đóng cửa sổ) rồi chạy lại file này."),
            );
        }
        throw e;
    }

    const configPath = userConfigPath();
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { modules?: string[] };
            if (Array.isArray(config.modules)) {
                config.modules = config.modules.filter((m) => m !== "/modules/nivris.js");
                fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
                log(`Đã bỏ "/modules/nivris.js" khỏi ${configPath}`);
            }
        } catch {
            log(`Cảnh báo: không đọc được ${configPath}, bỏ qua bước dọn config.`);
        }
    }

    log("XONG. Tắt hẳn Element rồi mở lại — về trạng thái gốc, không còn N.I.V.R.I.S.");
    finish(TITLE, true);
}

try {
    main();
} catch (e) {
    fail(e instanceof Error ? e.message : String(e));
}
