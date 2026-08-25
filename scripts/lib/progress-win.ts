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
$form.ClientSize = New-Object System.Drawing.Size(420, 110)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Dang chuan bi...'
$label.SetBounds(20, 18, 380, 20)
$form.Controls.Add($label)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.SetBounds(20, 48, 380, 24)
$bar.Minimum = 0
$bar.Maximum = 100
$form.Controls.Add($bar)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
    if (-not (Test-Path $StatusFile)) { return }
    try { $s = Get-Content $StatusFile -Raw | ConvertFrom-Json } catch { return }
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
`;

function writeStatus(s: Status): void {
    if (!statusFile) return;
    try {
        fs.writeFileSync(statusFile, JSON.stringify(s));
    } catch {
        // best-effort — a failed status write just means the bar doesn't move this tick
    }
}

/** Spawns the detached progress window. No-op outside Windows. */
export function startProgress(title: string): void {
    if (process.platform !== "win32") return;
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nivris-progress-"));
        statusFile = path.join(dir, "status.json");
        const scriptFile = path.join(dir, "progress.ps1");
        fs.writeFileSync(scriptFile, PS_SCRIPT);
        writeStatus({ percent: 0, label: "Dang chuan bi...", done: false });
        Bun.spawn(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                scriptFile,
                "-StatusFile",
                statusFile,
                "-Title",
                title,
            ],
            { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
        );
    } catch {
        // PowerShell missing or unspawnable — fall back to no progress window at all; finish()
        // still needs to show *something*, handled by its own fallback when statusFile is null.
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
