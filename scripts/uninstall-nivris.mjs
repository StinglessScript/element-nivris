#!/usr/bin/env node
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Reverses install-nivris.mjs: restores the original webapp.asar and removes the "modules"
// entry from the user's local config.json. Usage:  node scripts/uninstall-nivris.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findElementResourcesDirWindows } from "./lib/find-element-windows.mjs";

function log(msg) {
    console.log(`[nivris-uninstall] ${msg}`);
}
function fail(msg) {
    console.error(`[nivris-uninstall][ERROR] ${msg}`);
    process.exit(1);
}

function resourcesDirFromAppPath(appPath) {
    return process.platform === "darwin" ? path.join(appPath, "Contents/Resources") : path.join(appPath, "resources");
}

function findElementApp() {
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

    if (process.platform === "linux") {
        const candidates = ["/opt/Element", "/opt/element-desktop", "/usr/lib/element-desktop"];
        const found = candidates.find((p) => fs.existsSync(p));
        if (!found) fail("Không tìm thấy bản cài Element ở /opt/Element (chỉ hỗ trợ bản .deb/apt).");
        return resourcesDirFromAppPath(found);
    }

    fail(`Chưa hỗ trợ nền tảng: ${process.platform}`);
}

/** Under `sudo`, os.homedir()/$XDG_CONFIG_HOME resolve to root's, not the invoking user's. */
function realHomeDir() {
    if (process.env.SUDO_UID) {
        try {
            return os.userInfo({ uid: Number(process.env.SUDO_UID) }).homedir;
        } catch {
            // fall through
        }
    }
    return os.homedir();
}

function userConfigPath() {
    if (process.platform === "darwin") return path.join(realHomeDir(), "Library/Application Support/Element/config.json");
    if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "Element/config.json");
    if (process.platform === "linux") {
        const configHome = process.env.SUDO_UID ? null : process.env.XDG_CONFIG_HOME;
        return path.join(configHome || path.join(realHomeDir(), ".config"), "Element/config.json");
    }
    fail(`Chưa hỗ trợ nền tảng: ${process.platform}`);
}

function main() {
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
        if (e.code === "EPERM" || e.code === "EACCES") {
            if (process.platform === "darwin") {
                fail("Không có quyền ghi — cấp quyền 'App Management' cho Terminal trong System Settings rồi thử lại.");
            }
            if (process.platform === "linux") {
                fail(`Không có quyền ghi vào ${resourcesDir}. Chạy lại với sudo.`);
            }
            fail(`Không có quyền ghi vào ${resourcesDir}. Thử chạy lại với quyền Administrator.`);
        }
        throw e;
    }

    const configPath = userConfigPath();
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            if (Array.isArray(config.modules)) {
                config.modules = config.modules.filter((m) => m !== "/modules/nivris.js");
                fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
                log(`Đã bỏ "/modules/nivris.js" khỏi ${configPath}`);
                if (process.platform === "linux" && process.env.SUDO_UID) {
                    try {
                        fs.chownSync(configPath, Number(process.env.SUDO_UID), Number(process.env.SUDO_GID ?? process.env.SUDO_UID));
                    } catch (e) {
                        log(`Cảnh báo: không đổi được chủ sở hữu ${configPath} về user thường (${e.message}).`);
                    }
                }
            }
        } catch {
            log(`Cảnh báo: không đọc được ${configPath}, bỏ qua bước dọn config.`);
        }
    }

    log("XONG. Tắt hẳn Element rồi mở lại — về trạng thái gốc, không còn Nivris.");
}

main();
