/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Installs/removes the persistent nivris-update-helper.mjs as a background OS service (LaunchAgent
// on macOS, Scheduled Task on Windows, systemd --user unit on Linux) and copies the helper's own
// small file tree (script + its "./lib" deps + a generated config) into a stable, install-agnostic
// location — unlike the repo itself (fetched fresh into an ephemeral npx cache every run), this
// needs to keep existing after the `nivris-install`/`npx` process that created it exits.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { realHomeDir } from "./apply-update.mjs";

const LAUNCH_AGENT_LABEL = "com.nivris.updater";
const WIN_TASK_NAME = "NivrisUpdater";
const SYSTEMD_UNIT = "nivris-updater.service";
const HELPER_PORT = 47291;

export function helperInstallDir() {
    if (process.platform === "darwin") return path.join(realHomeDir(), "Library/Application Support/Nivris/helper");
    if (process.platform === "win32") return path.join(process.env.APPDATA ?? realHomeDir(), "Nivris/helper");
    return path.join(realHomeDir(), ".config/nivris/helper");
}

function launchAgentPlistPath() {
    return path.join(realHomeDir(), `Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`);
}

function systemdUnitPath() {
    return path.join(realHomeDir(), `.config/systemd/user/${SYSTEMD_UNIT}`);
}

/**
 * Bundles the helper script + its ./lib deps (including @electron/asar, needed to re-extract a
 * fresh webapp.asar after Element's own auto-updater wipes the patch) into a single self-contained
 * file at a stable location, independent of the ephemeral npx-fetched repo checkout that's running
 * this installer — see bundle-helper.mjs's doc comment for why this needs to be a bundle rather
 * than plain copies. Regenerates the shared secret every time (rotates on every update,
 * install-nivris.mjs bakes the same value into the built module).
 *
 * Only this plain-Node install path (`nivris-install` via npm/npx) needs bundling at install time
 * — the standalone Bun-compiled installer (standalone-installer.ts) gets an equivalent bundle for
 * free from `bun build --compile` and never calls this function. bundle-helper.mjs is imported
 * dynamically, not at this file's top level, specifically so that fact holds: `rollup` ships a
 * platform-native addon (e.g. @rollup/rollup-darwin-arm64) that Bun's compiler can't embed, so a
 * static top-level import here would drag rollup's eager native-binary load into every consumer of
 * this module — including standalone-installer.ts, which imports helperInstallDir/
 * registerHelperService from this same file — and crash the compiled standalone installer on
 * startup even though it never calls installHelperFiles at all.
 */
export async function installHelperFiles({ scriptsDir, repo, log }) {
    const dir = helperInstallDir();
    fs.mkdirSync(dir, { recursive: true });
    const { bundleHelperScript } = await import("./bundle-helper.mjs");
    await bundleHelperScript(path.join(scriptsDir, "nivris-update-helper.mjs"), path.join(dir, "nivris-update-helper.mjs"));

    const token = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(dir, "helper-config.json"), JSON.stringify({ port: HELPER_PORT, token, repo }, null, 4));
    log?.(`Đã cài helper cập nhật nền tại ${dir}`);
    return { dir, token, port: HELPER_PORT };
}

function killByPidFile(dir) {
    const pidFile = path.join(dir, "helper.pid");
    if (!fs.existsSync(pidFile)) return;
    try {
        const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
        if (pid) process.kill(pid, process.platform === "win32" ? undefined : "SIGTERM");
    } catch {
        // already dead — fine
    }
    fs.rmSync(pidFile, { force: true });
}

/**
 * Registers the helper to start at login and starts it immediately.
 *
 * `execPath` is the actual executable to invoke — either `process.execPath` (absolute path,
 * rather than "node": LaunchAgent/Task Scheduler run in a minimal login environment whose PATH may
 * not include the user's shell-configured Node) paired with `args: [scriptPath]` for the plain-Node
 * `nivris-install` CLI path, or a self-contained compiled helper binary's own path paired with
 * `args: []` for the standalone-installer path (no separate interpreter, no `scripts/` checkout on
 * disk for it to run from — see standalone-installer.ts's installHelperFilesStandalone()).
 */
export function registerHelperService({ execPath, args = [], helperDir, log }) {
    if (process.platform === "darwin") {
        const plistPath = launchAgentPlistPath();
        fs.mkdirSync(path.dirname(plistPath), { recursive: true });
        const argElements = [execPath, ...args].map((a) => `        <string>${a}</string>`).join("\n");
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argElements}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
    <key>StandardOutPath</key><string>${path.join(helperDir, "helper.log")}</string>
    <key>StandardErrorPath</key><string>${path.join(helperDir, "helper.log")}</string>
</dict>
</plist>
`;
        fs.writeFileSync(plistPath, plist);
        spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" }); // ignore failure — may not be loaded yet
        spawnSync("launchctl", ["load", plistPath], { stdio: "ignore" });
        log?.("Đã đăng ký LaunchAgent cho helper cập nhật.");
        return;
    }

    if (process.platform === "win32") {
        // schtasks can't hide the console window a plain invocation would open at logon — wrap it in
        // a hidden WScript launcher (window style 0), same trick scripts/lib/progress-win.ts already
        // uses for its own hidden PowerShell windows.
        const vbsPath = path.join(helperDir, "run-hidden.vbs");
        // Build the real Windows command line first ("path1" "path2" ...), then escape it as a
        // single VBScript string literal (VBScript escapes a literal `"` inside a string as `""`).
        const cmdLine = [execPath, ...args].map((a) => `"${a}"`).join(" ");
        const vbsEscaped = cmdLine.replace(/"/g, '""');
        fs.writeFileSync(vbsPath, `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${vbsEscaped}", 0, False\r\n`);
        spawnSync("schtasks", ["/delete", "/tn", WIN_TASK_NAME, "/f"], { stdio: "ignore" }); // ignore failure — may not exist yet
        spawnSync("schtasks", [
            "/create",
            "/tn",
            WIN_TASK_NAME,
            "/tr",
            `wscript.exe //B "${vbsPath}"`,
            "/sc",
            "onlogon",
            "/rl",
            "limited",
            "/f",
        ]);
        spawnSync("schtasks", ["/run", "/tn", WIN_TASK_NAME], { stdio: "ignore" });
        log?.("Đã đăng ký Scheduled Task cho helper cập nhật.");
        return;
    }

    if (process.platform === "linux") {
        const unitPath = systemdUnitPath();
        fs.mkdirSync(path.dirname(unitPath), { recursive: true });
        const unit = `[Unit]
Description=Nivris update helper

[Service]
ExecStart=${[execPath, ...args].join(" ")}
Restart=on-failure

[Install]
WantedBy=default.target
`;
        fs.writeFileSync(unitPath, unit);
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        spawnSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
        log?.("Đã đăng ký systemd --user unit cho helper cập nhật.");
        return;
    }
}

export function unregisterHelperService({ log }) {
    const dir = helperInstallDir();
    killByPidFile(dir);

    if (process.platform === "darwin") {
        const plistPath = launchAgentPlistPath();
        spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
        fs.rmSync(plistPath, { force: true });
    } else if (process.platform === "win32") {
        spawnSync("schtasks", ["/delete", "/tn", WIN_TASK_NAME, "/f"], { stdio: "ignore" });
    } else if (process.platform === "linux") {
        spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
        fs.rmSync(systemdUnitPath(), { force: true });
    }

    fs.rmSync(dir, { recursive: true, force: true });
    log?.("Đã gỡ helper cập nhật nền.");
}
