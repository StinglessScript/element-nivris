/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Shared patch logic used by scripts/install-nivris.mjs, scripts/uninstall-nivris.mjs, and the
// standalone Bun-compiled installer/uninstaller.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { findElementResourcesDirWindows } from "./find-element-windows.mjs";

export function resourcesDirFromAppPath(appPath) {
    return process.platform === "darwin" ? path.join(appPath, "Contents/Resources") : path.join(appPath, "resources");
}

export function findElementApp({ fail }) {
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

    if (process.platform === "linux") {
        const candidates = ["/opt/Element", "/opt/element-desktop", "/usr/lib/element-desktop"];
        const found = candidates.find((p) => fs.existsSync(p));
        if (!found) {
            fail(
                "Không tìm thấy bản cài Element ở /opt/Element (bản .deb/apt).\n" +
                    "Nếu bạn dùng AppImage hoặc Snap: cách này KHÔNG áp dụng được — AppImage là ảnh nén chỉ đọc,\n" +
                    "mount lại từ đầu mỗi lần chạy nên không có chỗ nào để lưu patch lâu dài; Snap thì sandbox chặn\n" +
                    "ghi ra ngoài thư mục dữ liệu riêng của nó. Cài bản .deb (apt) thay thế, hoặc chạy lại với\n" +
                    "ELEMENT_APP_PATH=/duong/dan/thu/muc/element (thư mục chứa 'resources/').",
            );
        }
        return resourcesDirFromAppPath(found);
    }

    fail(`Chưa hỗ trợ nền tảng: ${process.platform} (chỉ macOS, Windows, Linux .deb/apt).`);
}

/** Under `sudo`, os.homedir()/$XDG_CONFIG_HOME resolve to root's, not the invoking user's. */
export function realHomeDir() {
    if (process.env.SUDO_UID) {
        try {
            return os.userInfo({ uid: Number(process.env.SUDO_UID) }).homedir;
        } catch {
            // fall through
        }
    }
    return os.homedir();
}

export function userConfigPath({ fail }) {
    if (process.platform === "darwin") return path.join(realHomeDir(), "Library/Application Support/Element/config.json");
    if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "Element/config.json");
    if (process.platform === "linux") {
        const configHome = process.env.SUDO_UID ? null : process.env.XDG_CONFIG_HOME;
        return path.join(configHome || path.join(realHomeDir(), ".config"), "Element/config.json");
    }
    fail(`Chưa hỗ trợ nền tảng: ${process.platform}`);
}

export function buildModule({ moduleDir, log, fail, env }) {
    log("Building module (vite build)...");
    const isWin = process.platform === "win32";
    const res = spawnSync(isWin ? "npx.cmd" : "npx", ["vite", "build"], {
        cwd: moduleDir,
        stdio: "inherit",
        env: { ...process.env, ...env },
    });
    if (res.status !== 0) fail("Build thất bại — xem log phía trên.");
}

export function guardPermissionError(e, resourcesDir, { fail }) {
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
        if (process.platform === "linux") {
            fail(`Không có quyền ghi vào ${resourcesDir}. Chạy lại với sudo (ví dụ: sudo npx -p github:StinglessScript/element-nivris nivris-install).`);
        }
        fail(`Không có quyền ghi vào ${resourcesDir}. Thử chạy lại với quyền Administrator.`);
    }
    if (e && e.code === "EBUSY") {
        fail(
            "Element đang chạy nên file đang bị khoá, không sửa được.\n" +
                (process.platform === "win32"
                    ? "Element hay ẩn xuống khay hệ thống (system tray, cạnh đồng hồ) thay vì thoát hẳn khi đóng cửa sổ.\n" +
                      "Chuột phải vào icon Element trong khay hệ thống → Quit/Exit (hoặc mở Task Manager, End Task mọi\n" +
                      "tiến trình 'Element'), rồi chạy lại lệnh này."
                    : "Tắt hẳn Element (Cmd+Q, không chỉ đóng cửa sổ) rồi chạy lại lệnh này."),
        );
    }
    throw e;
}

/**
 * Applies the Nivris patch to the found Element install: builds the module, extracts webapp.asar
 * (idempotent — safe to call again on an already-patched install), copies the built module in,
 * and registers it in config.json. `moduleDir` is the repo root (where package.json/vite.config.ts
 * live); `env` is passed through to the vite build step (used to bake in the build SHA — see
 * install-nivris.mjs and src/nivris/NivrisUpdateChecker.ts).
 */
export async function applyNivrisUpdate({ moduleDir, env = {}, onStatus }) {
    const log = (msg) => onStatus?.(msg);
    const fail = (msg) => {
        throw new Error(msg);
    };

    const resourcesDir = findElementApp({ fail });
    log(`Element resources: ${resourcesDir}`);

    const webappAsar = path.join(resourcesDir, "webapp.asar");
    const webappBackup = path.join(resourcesDir, "webapp.asar.nivris-backup");
    const webappDir = path.join(resourcesDir, "webapp");

    buildModule({ moduleDir, log, fail, env });

    const builtJs = path.join(moduleDir, "lib/index.js");
    if (!fs.existsSync(builtJs)) fail("Không tìm thấy lib/index.js sau khi build.");

    try {
        if (fs.existsSync(webappDir)) {
            log("webapp/ đã tồn tại (đã cài trước đó) — chỉ cập nhật module.");
            if (fs.existsSync(webappAsar)) {
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

        const modulesDir = path.join(webappDir, "modules");
        fs.mkdirSync(modulesDir, { recursive: true });
        fs.copyFileSync(builtJs, path.join(modulesDir, "nivris.js"));
        const map = `${builtJs}.map`;
        if (fs.existsSync(map)) fs.copyFileSync(map, path.join(modulesDir, "nivris.js.map"));
        log("Đã copy nivris.js vào webapp/modules/");
    } catch (e) {
        guardPermissionError(e, resourcesDir, { fail });
    }

    const configPath = userConfigPath({ fail });
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

    if (process.platform === "linux" && process.env.SUDO_UID) {
        try {
            fs.chownSync(configPath, Number(process.env.SUDO_UID), Number(process.env.SUDO_GID ?? process.env.SUDO_UID));
        } catch (e) {
            log(`Cảnh báo: không đổi được chủ sở hữu ${configPath} về user thường (${e.message}).`);
        }
    }

    return { resourcesDir, webappDir };
}
