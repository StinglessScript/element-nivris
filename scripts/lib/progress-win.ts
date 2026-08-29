/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Windows-only progress window for the standalone installer/uninstaller. The compiled .exe is
// built with --windows-hide-console, so there is no window at all by default — running it just
// looks like nothing happened for a second, then (with the old code) a single MessageBox popped
// up. This spawns a small detached PowerShell/WinForms process that shows a real progress bar,
// driven by writing percent/label updates to a JSON status file it polls. No IPC library needed
// for a handful of updates over a install that takes well under a second.
//
// No-ops on macOS/Linux — those platforms get their feedback elsewhere (see finish.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Status = { percent: number; label: string; done: boolean; ok?: boolean; message?: string };

let statusFile: string | null = null;

const PS_SCRIPT = String.raw`
param([string]$StatusFile, [string]$Title)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$form.BackColor = [System.Drawing.Color]::White
$form.ClientSize = New-Object System.Drawing.Size(440, 130)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Dang chuan bi...'
$label.ForeColor = [System.Drawing.Color]::FromArgb(40, 40, 40)
$label.SetBounds(24, 28, 392, 22)
$form.Controls.Add($label)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.SetBounds(24, 60, 392, 22)
$bar.Minimum = 0
$bar.Maximum = 100
$form.Controls.Add($bar)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
    if (-not (Test-Path $StatusFile)) { return }
    # Get-Content's default encoding on Windows PowerShell 5.1 is the system codepage, not UTF-8 —
    # since the .exe (via Bun/Node) always writes this file as UTF-8, reading it any other way
    # mangles the Vietnamese text. Read the bytes and decode explicitly instead.
    try { $s = [System.IO.File]::ReadAllText($StatusFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return }
    $bar.Value = [Math]::Min([Math]::Max([int]$s.percent, 0), 100)
    $label.Text = $s.label
    if ($s.done) {
        $timer.Stop()
        $icon = if ($s.ok) { 'Information' } else { 'Error' }
        $shownTitle = if ($s.ok) { $Title } else { "$Title - Loi" }
        [System.Windows.Forms.MessageBox]::Show($s.message, $shownTitle, 'OK', $icon) | Out-Null
        $form.Close()
    }
})
$timer.Start()
$form.Add_Shown({ $form.Activate() })
[System.Windows.Forms.Application]::Run($form)

# This script and its status file live in a per-run temp dir (see startProgress() below) that
# nothing else ever cleans up — the installer process that created it is long gone by the time the
# user dismisses the MessageBox above, so this detached script is the only thing left that still
# knows its own directory and the right moment (after the dialog closes, not before) to remove it.
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Split-Path $StatusFile -Parent)
`;

function writeStatus(s: Status): void {
    if (!statusFile) return;
    try {
        fs.writeFileSync(statusFile, JSON.stringify(s));
    } catch {
        // best-effort — a failed status write just means the bar doesn't move this tick
    }
}

/** Quotes one command-line argument for a Windows argv-style command line (cmd.exe / CreateProcess
 * conventions — not shell quoting, there's no shell involved). */
function quoteArg(arg: string): string {
    if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '\\"')}"`;
}

/** Escapes a string for embedding inside a VBScript double-quoted string literal. */
function vbsEscape(s: string): string {
    return s.replace(/"/g, '""');
}

/** Windows PowerShell 5.1 only reliably auto-detects UTF-8 script files when they start with a
 * BOM — without one it falls back to the system codepage, which mangles Vietnamese text embedded
 * in the script (or, for .vbs, mangles the Title text baked into the command line at write time). */
function writeUtf8Bom(filePath: string, content: string): void {
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]));
}

/** Windows Script Host (cscript/wscript) only reliably treats a .vbs file as Unicode with a
 * UTF-16LE BOM — the classic "Unicode text file" format, universally supported since VBScript
 * predates UTF-8 BOM conventions on Windows. */
function writeUtf16LeBom(filePath: string, content: string): void {
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]));
}

/** Spawns the detached progress window. No-op outside Windows. */
export function startProgress(title: string): void {
    if (process.platform !== "win32") return;
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nivris-progress-"));
        statusFile = path.join(dir, "status.json");
        const scriptFile = path.join(dir, "progress.ps1");
        writeUtf8Bom(scriptFile, PS_SCRIPT);
        writeStatus({ percent: 0, label: "Dang chuan bi...", done: false });

        // Launched via WScript.Shell.Run (window style 0 = hidden) rather than
        // `powershell -WindowStyle Hidden` directly: PowerShell/conhost still briefly allocates a
        // visible console before applying that style, which flashes on screen for an instant.
        // WScript.Shell.Run creates the process hidden from the start — no console ever appears.
        const psCommandLine = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptFile,
            "-StatusFile",
            statusFile,
            "-Title",
            title,
        ]
            .map(quoteArg)
            .join(" ");
        const vbsFile = path.join(dir, "launch.vbs");
        writeUtf16LeBom(vbsFile, `CreateObject("WScript.Shell").Run "${vbsEscape(psCommandLine)}", 0, False\n`);
        Bun.spawn(["wscript.exe", "//B", "//NoLogo", vbsFile], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
            windowsHide: true,
        });
    } catch {
        // PowerShell/WScript missing or unspawnable — fall back to no progress window at all;
        // finish() still needs to show *something*, handled by its own fallback when statusFile is null.
        statusFile = null;
    }
}

/** Updates the progress bar. No-op if startProgress() wasn't called or failed. */
export function setProgress(percent: number, label: string): void {
    writeStatus({ percent, label, done: false });
}

/** True once startProgress() has successfully spawned the window. */
export function progressActive(): boolean {
    return statusFile !== null;
}

/** Tells the progress window to show the final message and close. No-op outside Windows. */
export function endProgress(ok: boolean, message: string): void {
    writeStatus({ percent: 100, label: "", done: true, ok, message });
}
