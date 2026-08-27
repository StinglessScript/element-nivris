/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Shared patch logic used by both the one-shot `nivris-install` CLI and the persistent
// nivris-update-helper background service, so the two never drift apart. Everything here is pure
// Node (no Bun-only APIs) since the helper runs under a plain `node` invocation registered in a
// LaunchAgent/Scheduled Task/systemd unit, not a compiled Bun binary.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { findElementResourcesDirWindows } from "./find-element-windows.mjs";

/** Follows redirects (GitHub's release download URLs 302 to S3) — Node's https module doesn't. */
export function downloadFile(url, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { "user-agent": "nivris-update-helper" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (maxRedirects <= 0) return reject(new Error("Quá nhiều redirect."));
                return resolve(downloadFile(res.headers.location, destPath, maxRedirects - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Tải thất bại (HTTP ${res.statusCode}): ${url}`));
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on("finish", () => file.close(resolve));
            file.on("error", reject);
        });
        req.on("error", reject);
    });
}

// The CI-published `nivris-module.js` (see .github/workflows/release.yml) is one shared public
// build for every user, so it can't have any one user's real update-helper token baked in at
// build time the way a local `nivris-install` run does. CI bakes in this literal placeholder
// instead; applyNivrisUpdate() text-substitutes it for the real per-machine token (already sitting
// in the local helper-config.json, unaffected by re-downloading a new module build) before writing
// the file into webapp/modules/ — safe to do after minification since minifiers don't rewrite
// string-literal contents, only identifiers.
export const TOKEN_PLACEHOLDER = "__NIVRIS_TOKEN_PLACEHOLDER__";

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

/**
 * Best-effort native prompt for the one-time macOS permission grant a fresh background-helper
 * install needs (see guardPermissionError's "helper" branch doc comment). Mirrors the
 * "Đóng"/"Mở Cài đặt" dialog scripts/build-app-bundle.sh already shows for the compiled
 * installer/uninstaller — same one-click deep link to the right Settings pane — plus copies the
 * exact binary path to the clipboard first, since the Settings "+" file picker has no way to jump
 * straight to a hidden, deeply-nested nvm path otherwise (Cmd+Shift+G then Cmd+V gets there in two
 * keystrokes instead of manual Finder navigation).
 */
function promptMacAppManagementGrant(execPath) {
    try {
        spawnSync("pbcopy", { input: execPath });
    } catch {
        // clipboard copy is a nicety, not required — dialog text below still has the raw path
    }
    const msg =
        `Cần cấp quyền cho tiến trình cập nhật nền (đã copy đường dẫn vào clipboard):\\n${execPath}\\n\\n` +
        `Bấm "Mở Cài đặt" → bấm "+" → Cmd+Shift+G → Cmd+V → Enter → Open → bật toggle lên.\\n` +
        `Rồi quay lại app, bấm Cập nhật lại.`;
    try {
        const choice = spawnSync("osascript", [
            "-e",
            `display dialog "${msg}" with title "N.I.V.R.I.S. — Cần cấp quyền" buttons {"Đóng", "Mở Cài đặt"} default button "Mở Cài đặt" with icon caution`,
            "-e",
            "button returned of result",
        ]);
        if ((choice.stdout ?? "").toString().trim() === "Mở Cài đặt") {
            spawnSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AppManagement"]);
        }
    } catch {
        // best-effort — the thrown error's own text still has the manual instructions
    }
}

export function guardPermissionError(e, resourcesDir, { fail, errorContext = "cli" }) {
    if (e && (e.code === "EPERM" || e.code === "EACCES")) {
        if (process.platform === "darwin") {
            if (errorContext === "helper") {
                // macOS's "App Management" TCC grant is per requesting-process — Terminal already
                // has it (that's how the initial `nivris-install` run worked), but the background
                // helper is a *different* process (node, run via LaunchAgent, no Terminal involved)
                // that's never been granted it, so it needs its own separate grant. One-time only:
                // once granted, this exact node binary keeps working for every future update.
                promptMacAppManagementGrant(process.execPath);
                fail(
                    `Không có quyền ghi vào ${resourcesDir}.\n` +
                        "Tiến trình cập nhật nền (node) chưa được cấp quyền 'App Management' — quyền này tính riêng theo\n" +
                        "từng tiến trình, được cấp cho Terminal không có nghĩa là helper chạy nền cũng có.\n" +
                        `Mở System Settings → Privacy & Security → App Management → bấm "+" → chọn file:\n` +
                        `  ${process.execPath}\n` +
                        "rồi bật nó lên. Sau đó thử bấm Cập nhật lại trong app.",
                );
            }
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
 * Applies the Nivris patch to the found Element install: gets a built `nivris.js`, extracts
 * webapp.asar (idempotent — safe to call again on an already-patched install), copies the module
 * in, and registers it in config.json.
 *
 * Two ways to supply the built JS:
 *   - `moduleDir` (repo root, has package.json/vite.config.ts) — runs `vite build` there. Used by
 *     the one-shot `nivris-install` CLI, which already has the full repo on disk via npx.
 *   - `builtJsPath` — an already-built index.js, used as-is. Used by the background updater
 *     helper, which downloads a prebuilt module from the latest GitHub Release instead of rebuilding
 *     from source on the user's machine (no git/npm-install/vite-build needed at update time).
 * Exactly one of the two must be given.
 *
 * `realToken`, when given, text-substitutes TOKEN_PLACEHOLDER for the real per-machine token in
 * the built JS before it's copied in — needed when `builtJsPath` points at the shared public CI
 * build (see TOKEN_PLACEHOLDER's doc comment above).
 */
export async function applyNivrisUpdate({ moduleDir, builtJsPath, realToken, env = {}, onStatus, errorContext = "cli" }) {
    const log = (msg) => onStatus?.(msg);
    const fail = (msg) => {
        throw new Error(msg);
    };

    const resourcesDir = findElementApp({ fail });
    log(`Element resources: ${resourcesDir}`);

    const webappAsar = path.join(resourcesDir, "webapp.asar");
    const webappBackup = path.join(resourcesDir, "webapp.asar.nivris-backup");
    const webappDir = path.join(resourcesDir, "webapp");

    let builtJs = builtJsPath;
    if (!builtJs) {
        buildModule({ moduleDir, log, fail, env });
        builtJs = path.join(moduleDir, "lib/index.js");
    }
    if (!fs.existsSync(builtJs)) fail(`Không tìm thấy module đã build tại ${builtJs}.`);

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
        if (realToken) {
            const contents = fs.readFileSync(builtJs, "utf-8").split(TOKEN_PLACEHOLDER).join(realToken);
            fs.writeFileSync(path.join(modulesDir, "nivris.js"), contents);
        } else {
            fs.copyFileSync(builtJs, path.join(modulesDir, "nivris.js"));
        }
        const map = `${builtJs}.map`;
        if (fs.existsSync(map)) fs.copyFileSync(map, path.join(modulesDir, "nivris.js.map"));
        log("Đã copy nivris.js vào webapp/modules/");
    } catch (e) {
        guardPermissionError(e, resourcesDir, { fail, errorContext });
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

function isRunningWindows() {
    try {
        const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq Element.exe", "/FO", "CSV", "/NH"], { encoding: "utf-8" });
        return (out.stdout ?? "").toLowerCase().includes("element.exe");
    } catch {
        return false;
    }
}

function isRunningMac() {
    try {
        return spawnSync("pgrep", ["-x", "Element"]).status === 0;
    } catch {
        return false;
    }
}

async function waitUntilClosed(isRunning, timeoutMs) {
    const start = Date.now();
    while (isRunning()) {
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return true;
}

/**
 * Best-effort graceful-then-forceful quit, mirroring scripts/lib/quit-element.ts (that file is
 * Bun-only — uses Bun.spawnSync — so it can't be imported by this plain-Node helper; kept in sync
 * by hand). Never throws.
 */
export async function quitElementIfRunning(onStatus) {
    if (process.platform === "win32") {
        if (!isRunningWindows()) return true;
        onStatus?.("Element đang chạy — đang tắt...");
        try {
            spawnSync("taskkill", ["/IM", "Element.exe", "/T"]);
        } catch {
            // ignore
        }
        if (await waitUntilClosed(isRunningWindows, 5000)) return true;
        try {
            spawnSync("taskkill", ["/IM", "Element.exe", "/T", "/F"]);
        } catch {
            // ignore
        }
        return waitUntilClosed(isRunningWindows, 5000);
    }

    if (process.platform === "darwin") {
        if (!isRunningMac()) return true;
        onStatus?.("Element đang chạy — đang tắt...");
        try {
            spawnSync("osascript", ["-e", 'tell application "Element" to quit']);
        } catch {
            // ignore
        }
        if (await waitUntilClosed(isRunningMac, 5000)) return true;
        try {
            spawnSync("pkill", ["-x", "Element"]);
        } catch {
            // ignore
        }
        return waitUntilClosed(isRunningMac, 5000);
    }

    return true;
}

/** Best-effort relaunch after a helper-driven update — the user never touches a terminal for this. */
export function relaunchElement() {
    try {
        if (process.platform === "darwin") {
            spawnSync("open", ["-a", "Element"]);
        } else if (process.platform === "win32") {
            const resourcesDir = findElementApp({ fail: () => {} });
            if (resourcesDir) {
                const exe = path.join(path.dirname(resourcesDir), "Element.exe");
                if (fs.existsSync(exe)) spawnSync(exe, [], { detached: true, stdio: "ignore" });
            }
        } else if (process.platform === "linux") {
            spawnSync("element-desktop", [], { detached: true, stdio: "ignore" });
        }
    } catch {
        // best-effort — banner still tells the user to reopen Element manually if this silently fails
    }
}
