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

/** Copies the helper script + its ./lib deps into a stable location, independent of the ephemeral
 * npx-fetched repo checkout that's running this installer. Regenerates the shared secret every
 * time (rotates on every update, install-nivris.mjs bakes the same value into the built module). */
export function installHelperFiles({ scriptsDir, repo, log }) {
    const dir = helperInstallDir();
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.copyFileSync(path.join(scriptsDir, "nivris-update-helper.mjs"), path.join(dir, "nivris-update-helper.mjs"));
    fs.copyFileSync(path.join(scriptsDir, "lib/apply-update.mjs"), path.join(dir, "lib/apply-update.mjs"));
    fs.copyFileSync(path.join(scriptsDir, "lib/find-element-windows.mjs"), path.join(dir, "lib/find-element-windows.mjs"));

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

/** Registers the helper to start at login and starts it immediately. `nodeExec` is `process.execPath`
 * (absolute path) rather than "node" — LaunchAgent/Task Scheduler run in a minimal login environment
 * whose PATH may not include the user's shell-configured Node. */
export function registerHelperService({ nodeExec, helperDir, log }) {
    const scriptPath = path.join(helperDir, "nivris-update-helper.mjs");

    if (process.platform === "darwin") {
        const plistPath = launchAgentPlistPath();
        fs.mkdirSync(path.dirname(plistPath), { recursive: true });
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeExec}</string>
        <string>${scriptPath}</string>
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
        // schtasks can't hide the console window a plain `node.exe` invocation would open at logon —
        // wrap it in a hidden WScript launcher (window style 0), same trick scripts/lib/progress-win.ts
        // already uses for its own hidden PowerShell windows.
        const vbsPath = path.join(helperDir, "run-hidden.vbs");
        fs.writeFileSync(
            vbsPath,
            `Set shell = CreateObject("WScript.Shell")\r\nshell.Run """${nodeExec}"" ""${scriptPath}""", 0, False\r\n`,
        );
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
ExecStart=${nodeExec} ${scriptPath}
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
