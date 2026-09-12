#!/usr/bin/env node
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Parses the installer's progress-window PowerShell with PowerShell's own parser, and fails the
// build on a syntax error.
//
// That script is written to a temp file and launched hidden, by a GUI-subsystem executable, from a
// detached WScript process. Every one of those layers swallows output, so a syntax error in it
// doesn't produce an error anywhere — the window simply never appears and the install carries on
// silently. That is exactly how it shipped once. The Windows runner has the same PowerShell, so it
// can answer the question before a user has to.
//
// Usage:  node scripts/check-progress-ps.mjs          (no-op off Windows)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "scripts/lib/progress-win.ts"), "utf-8");

const marker = "const PS_SCRIPT = String.raw`";
const start = source.indexOf(marker);
if (start === -1) {
    console.error("[check-ps] Không tìm thấy PS_SCRIPT trong progress-win.ts");
    process.exit(1);
}
const end = source.indexOf("`;", start + marker.length);
// A short stand-in for the real base64: this checks syntax, and 10KB of image data on one line adds
// nothing but noise to the parser's error positions.
const script = source.slice(start + marker.length, end).replace("__LOGO_B64__", "AAAA");

if (process.platform !== "win32") {
    console.log("[check-ps] Bỏ qua (chỉ chạy được trên Windows).");
    process.exit(0);
}

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nivris-psheck-")), "progress.ps1");
fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, "utf8")]));

const res = spawnSync(
    "powershell",
    [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // Parse only — running it would open a window and block forever waiting to be closed.
        "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('" +
            file.replace(/'/g, "''") +
            "', [ref]$null, [ref]$errors); " +
            "if ($errors.Count) { $errors | ForEach-Object { Write-Host (\"{0} (dong {1})\" -f $_.Message, $_.Extent.StartLineNumber) }; exit 1 } " +
            "else { Write-Host 'progress.ps1 OK'; exit 0 }",
    ],
    { encoding: "utf-8" },
);
process.stdout.write(res.stdout ?? "");
process.stderr.write(res.stderr ?? "");
process.exit(res.status ?? 1);
