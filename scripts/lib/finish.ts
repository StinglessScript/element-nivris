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
//     nothing printed to stdout would ever be seen. progress-win.ts's window (started by the
//     caller via startProgress()) shows the final MessageBox itself once told the run is done; if
//     that window never came up (PowerShell missing, etc.) fall back to a one-off MessageBox here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { endProgress, progressActive } from "./progress-win";

const logLines: string[] = [];

/** Node has no sleepSync; Atomics.wait on a throwaway buffer blocks the thread without spinning.
 * Used in exactly one place, where the process is about to exit anyway. */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function log(prefix: string, msg: string): void {
    logLines.push(msg);
    try {
        console.log(`[${prefix}] ${msg}`);
    } catch {
        // A GUI-subsystem build has no console attached, so stdout can be an invalid handle —
        // logLines above is the copy that actually matters (finish() shows it on failure).
    }
}

/** The end-of-run dialog. Deliberately a real window rather than a MessageBox: a MessageBox can
 * only say OK, and the one thing someone hitting a failed install actually needs is to SEE the log
 * — on a machine whose keyboard may not work, typing a path into Explorer is not a fallback. So
 * this carries "Xem nhật ký" (opens the log in a scrollable window) and "Sao chép nhật ký" (straight
 * to the clipboard), both reachable with the mouse alone. */
const RESULT_PS = `param([string]$Title, [string]$Body, [string]$IsError, [string]$LogPath)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Show-Text($caption, $text) {
    $w = New-Object System.Windows.Forms.Form
    $w.Text = $caption
    $w.Width = 900
    $w.Height = 620
    $w.StartPosition = 'CenterScreen'
    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true
    $box.ReadOnly = $true
    $box.ScrollBars = 'Both'
    $box.WordWrap = $false
    $box.Dock = 'Fill'
    $box.Font = New-Object System.Drawing.Font('Consolas', 9.5)
    $box.Text = $text
    $w.Controls.Add($box)
    [void]$w.ShowDialog()
}

function Read-Log($path) {
    if ([string]::IsNullOrEmpty($path)) { return '' }
    if (-not (Test-Path $path)) { return "Chua co file: $path" }
    try { return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) } catch { return "Khong doc duoc: $path" }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = if ($IsError -eq '1') { "$Title - Loi" } else { $Title }
$form.Width = 620
$form.Height = 300
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$msg = New-Object System.Windows.Forms.TextBox
$msg.Multiline = $true
$msg.ReadOnly = $true
$msg.ScrollBars = 'Vertical'
$msg.BorderStyle = 'None'
$msg.BackColor = $form.BackColor
$msg.Dock = 'Fill'
$msg.Text = $Body
$form.Controls.Add($msg)

$bar = New-Object System.Windows.Forms.FlowLayoutPanel
$bar.Dock = 'Bottom'
$bar.Height = 48
$bar.FlowDirection = 'RightToLeft'
$bar.Padding = New-Object System.Windows.Forms.Padding(8, 8, 8, 8)

$close = New-Object System.Windows.Forms.Button
$close.Text = 'Dong'
$close.Width = 96
$close.Height = 30
$close.Add_Click({ $form.Close() })

$view = New-Object System.Windows.Forms.Button
$view.Text = 'Xem nhat ky'
$view.Width = 120
$view.Height = 30
$view.Add_Click({ Show-Text 'Nhat ky cai dat' (Read-Log $LogPath) })

$copy = New-Object System.Windows.Forms.Button
$copy.Text = 'Sao chep nhat ky'
$copy.Width = 140
$copy.Height = 30
$copy.Add_Click({
    [System.Windows.Forms.Clipboard]::SetText((Read-Log $LogPath))
    [System.Windows.Forms.MessageBox]::Show('Da sao chep nhat ky vao clipboard.', 'OK') | Out-Null
})

$bar.Controls.AddRange(@($close, $view, $copy))
$form.Controls.Add($bar)
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
`;

function showResultWindow(title: string, body: string, isError: boolean, logPath: string | null): void {
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nivris-result-"));
        const script = path.join(dir, "result.ps1");
        // PowerShell 5.1 only detects a UTF-8 script reliably with a BOM; without one the Vietnamese
        // in this script comes out mangled.
        fs.writeFileSync(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(RESULT_PS, "utf8")]));
        spawnSync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Title", title, "-Body", body, "-IsError", isError ? "1" : "0", "-LogPath", logPath ?? ""],
            { stdio: "ignore", windowsHide: true },
        );
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best-effort — if PowerShell somehow isn't available, there's nothing else we can do
        // from a console-less compiled exe.
    }
}

/** Every run's log, written next to the helper so a failed install can be diagnosed afterwards.
 * The Windows build has no console window at all (GUI subsystem — see scripts/build-sea-win.mjs),
 * and the result dialog only shows a summary, so without this a bad install leaves no trace to
 * look at once the dialog is dismissed. */
function writeInstallLog(title: string, success: boolean): string | null {
    try {
        const dir =
            process.platform === "win32"
                ? path.join(process.env.APPDATA ?? os.homedir(), "Nivris")
                : path.join(os.homedir(), "Library/Application Support/Nivris");
        fs.mkdirSync(dir, { recursive: true });

        const header = `===== ${new Date().toISOString()} — ${title} — ${success ? "OK" : "LỖI"} =====`;
        const runLog = [header, ...logLines].join("\n");

        // Appended history, for comparing a bad run against the last good one.
        fs.appendFileSync(path.join(dir, "install.log"), `\n${runLog}\n`);

        // The update helper runs as its own background process, so when it fails to come up the
        // installer's own log says nothing useful — its reason is in the helper's log. The report
        // the dialog shows carries both, because "cài xong nhưng helper không chạy" is diagnosed
        // from the second half and nobody should have to go find a second file to read it.
        const helperLog = path.join(dir, "helper", "helper.log");
        let helperPart = `\n\n===== HELPER (${helperLog}) =====\n`;
        try {
            const text = fs.readFileSync(helperLog, "utf-8");
            const lines = text.split("\n");
            helperPart += lines.slice(-200).join("\n");
        } catch {
            helperPart += "(chưa có file — helper chưa từng chạy được lần nào)";
        }

        const report = path.join(dir, "bao-cao-cai-dat.txt");
        fs.writeFileSync(report, runLog + helperPart + "\n");
        return report;
    } catch {
        return null;
    }
}

export function finish(title: string, success: boolean, successMessage?: string): never {
    const logFile = writeInstallLog(title, success);
    if (process.platform === "win32") {
        const body = success ? (successMessage ?? "Hoàn tất.") : logLines.join("\n");
        if (progressActive()) {
            // The progress window turns itself into the result dialog (message + log buttons) and
            // stays up on its own after this process exits — no second window to spawn, and nothing
            // that can leave the run with no visible ending.
            endProgress(success, body, logFile);
            sleepSync(200);
        } else {
            // Only reached when the progress window never came up (PowerShell blocked, etc.).
            showResultWindow(title, body, !success, logFile);
        }
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
