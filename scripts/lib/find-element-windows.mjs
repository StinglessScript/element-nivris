/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Auto-detects where Element Desktop is installed on Windows. The Squirrel installer normally
// puts it at %LOCALAPPDATA%\Element\app-x.y.z, but that's not the only place it can end up (some
// installs land in %LOCALAPPDATA%\Programs, or a machine-wide Program Files install) — so this
// checks a few known locations first, then falls back to asking the Windows registry directly
// (the uninstall entry Squirrel/Electron registers has an authoritative InstallLocation).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function latestAppDir(base) {
    if (!fs.existsSync(base)) return undefined;
    const versions = fs.readdirSync(base).filter((d) => d.startsWith("app-"));
    if (!versions.length) return undefined;
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return path.join(base, versions[versions.length - 1]);
}

function registryInstallLocation() {
    const script = `
$paths = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Element*' } | Select-Object -First 1 -ExpandProperty InstallLocation
`;
    try {
        const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf-8",
            windowsHide: true,
        }).trim();
        return out || undefined;
    } catch {
        return undefined;
    }
}

/** Returns the Element Desktop "resources" directory (Contents/Resources equivalent), or undefined if not found anywhere. */
export function findElementResourcesDirWindows() {
    const bases = [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Element"),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Element"),
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Element"),
        process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Element"),
    ].filter(Boolean);

    for (const base of bases) {
        const appDir = latestAppDir(base);
        if (appDir) return path.join(appDir, "resources");
    }

    const regLoc = registryInstallLocation();
    if (regLoc && fs.existsSync(regLoc)) {
        const appDir = latestAppDir(regLoc);
        if (appDir) return path.join(appDir, "resources");
        if (fs.existsSync(path.join(regLoc, "resources"))) return path.join(regLoc, "resources");
    }

    return undefined;
}
