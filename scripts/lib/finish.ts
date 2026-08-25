/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Shared "how do we tell the user what happened" logic for the standalone installer/uninstaller,
// since the two platforms need very different endings:
//   - macOS: runs as a plain CLI (either directly, or captured+shown by the .app wrapper's own
//     dialog) — printing to stdout and pausing for a keypress is enough.
//   - Windows: compiled with --windows-hide-console, so there is no visible window at all —
//     nothing printed to stdout would ever be seen. Show a native MessageBox instead.

import fs from "node:fs";

const logLines: string[] = [];

export function log(prefix: string, msg: string): void {
    logLines.push(msg);
    console.log(`[${prefix}] ${msg}`);
}

function showWindowsMessageBox(title: string, body: string, isError: boolean): void {
    const esc = body.replace(/`/g, "``").replace(/'/g, "''").replace(/\$/g, "`$");
    const titleEsc = title.replace(/'/g, "''");
    const icon = isError ? "Error" : "Information";
    try {
        Bun.spawnSync(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${esc}', '${titleEsc}', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::${icon})`,
            ],
            { stdout: "ignore", stderr: "ignore" },
        );
    } catch {
        // Best-effort — if PowerShell somehow isn't available, there's nothing else we can do
        // from a console-less compiled exe.
    }
}

/** Ends the process, surfacing `logLines` (everything logged so far) to the user. Never returns. */
export function finish(title: string, success: boolean): never {
    if (process.platform === "win32") {
        showWindowsMessageBox(title, logLines.join("\n"), !success);
    } else {
        console.log("\nNhấn phím bất kỳ để đóng cửa sổ này...");
        try {
            fs.readSync(0, Buffer.alloc(1), 0, 1, null);
        } catch {
            // stdin may not be interactive (e.g. piped, or closed by the .app wrapper) — ignore.
        }
    }
    process.exit(success ? 0 : 1);
}
