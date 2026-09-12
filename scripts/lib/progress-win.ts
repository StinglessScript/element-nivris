/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { spawn } from "node:child_process";

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

import { HTA_HTML } from "./progress-hta";
import { LOGO_PNG_BASE64 } from "./logo-base64";

type Status = { percent: number; label: string; done: boolean; ok?: boolean; message?: string; logPath?: string };

let statusFile: string | null = null;

/** False once a progress window was asked for and never appeared — i.e. PowerShell doesn't run on
 * this machine, so finish() must not try to draw its result dialog with it either. */
let powershellUsable = true;

export function progressPowerShellUsable(): boolean {
    return powershellUsable;
}

const PS_SCRIPT = String.raw`
param([string]$StatusFile, [string]$Title)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$TEAL = [System.Drawing.Color]::FromArgb(10, 124, 122)
$INK = [System.Drawing.Color]::FromArgb(11, 27, 38)
$MUTED = [System.Drawing.Color]::FromArgb(90, 112, 128)
$TRACK = [System.Drawing.Color]::FromArgb(228, 233, 237)

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$form.BackColor = [System.Drawing.Color]::White
$form.ClientSize = New-Object System.Drawing.Size(720, 460)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

# Embedded at write time (see writeUtf8Bom's call site) — a single-file installer has no asset
# directory for this window to read an image out of.
$logoB64 = '__LOGO_B64__'
try {
    $bytes = [System.Convert]::FromBase64String($logoB64)
    $logo = New-Object System.Windows.Forms.PictureBox
    $logo.Image = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,$bytes)))
    $logo.SizeMode = 'Zoom'
    $logo.SetBounds(44, 36, 52, 52)
    $form.Controls.Add($logo)
} catch {
    # No logo is a cosmetic loss; never a reason to fail the install.
}

$brand = New-Object System.Windows.Forms.Label
$brand.Text = 'N.I.V.R.I.S.'
$brand.Font = New-Object System.Drawing.Font('Consolas', 12, [System.Drawing.FontStyle]::Bold)
$brand.ForeColor = $INK
$brand.SetBounds(110, 44, 220, 22)
$form.Controls.Add($brand)

$sub = New-Object System.Windows.Forms.Label
$sub.Text = 'Module cho Element Desktop'
$sub.ForeColor = $MUTED
$sub.SetBounds(112, 66, 320, 20)
$form.Controls.Add($sub)

$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'Vui long doi trong giay lat...'
$heading.Font = New-Object System.Drawing.Font('Segoe UI', 19, [System.Drawing.FontStyle]::Bold)
$heading.ForeColor = $INK
$heading.SetBounds(44, 150, 640, 40)
$form.Controls.Add($heading)

# A flat two-panel bar rather than Windows' own ProgressBar, which always draws its themed 3D
# chrome and cannot be made to look like the rest of this.
$track = New-Object System.Windows.Forms.Panel
$track.BackColor = $TRACK
$track.SetBounds(44, 220, 632, 6)
$form.Controls.Add($track)

$fill = New-Object System.Windows.Forms.Panel
$fill.BackColor = $TEAL
$fill.SetBounds(0, 0, 0, 6)
$track.Controls.Add($fill)

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Dang chuan bi...'
$label.ForeColor = $MUTED
$label.SetBounds(44, 238, 632, 22)
$form.Controls.Add($label)

# Result view, hidden until the run finishes — this window stays up and becomes the ending, rather
# than handing that job to another process that might never appear.
$script:LogPath = ''

$msg = New-Object System.Windows.Forms.TextBox
$msg.Multiline = $true
$msg.ReadOnly = $true
$msg.ScrollBars = 'Vertical'
$msg.BorderStyle = 'None'
$msg.BackColor = [System.Drawing.Color]::White
$msg.ForeColor = $INK
$msg.SetBounds(44, 210, 632, 160)
$msg.Visible = $false
$form.Controls.Add($msg)

function Read-Log {
    if ([string]::IsNullOrEmpty($script:LogPath)) { return 'Khong co duong dan nhat ky.' }
    if (-not (Test-Path $script:LogPath)) { return "Chua co file: $script:LogPath" }
    try { return [System.IO.File]::ReadAllText($script:LogPath, [System.Text.Encoding]::UTF8) }
    catch { return "Khong doc duoc: $script:LogPath" }
}

$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Dock = 'Bottom'
$panel.Height = 56
$panel.BackColor = [System.Drawing.Color]::White
$panel.FlowDirection = 'RightToLeft'
$panel.Padding = New-Object System.Windows.Forms.Padding(28, 12, 44, 12)
$panel.Visible = $false

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = 'Dong'
$btnClose.Width = 104
$btnClose.Height = 32
$btnClose.FlatStyle = 'Flat'
$btnClose.BackColor = $TEAL
$btnClose.ForeColor = [System.Drawing.Color]::White
$btnClose.FlatAppearance.BorderSize = 0
$btnClose.Add_Click({ $form.Close() })

$btnView = New-Object System.Windows.Forms.Button
$btnView.Text = 'Xem nhat ky'
$btnView.Width = 126
$btnView.Height = 32
$btnView.FlatStyle = 'Flat'
$btnView.Add_Click({
    $w = New-Object System.Windows.Forms.Form
    $w.Text = 'Nhat ky cai dat'
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
    $box.Text = (Read-Log)
    $w.Controls.Add($box)
    [void]$w.ShowDialog()
})

$btnCopy = New-Object System.Windows.Forms.Button
$btnCopy.Text = 'Sao chep nhat ky'
$btnCopy.Width = 146
$btnCopy.Height = 32
$btnCopy.FlatStyle = 'Flat'
$btnCopy.Add_Click({
    [System.Windows.Forms.Clipboard]::SetText((Read-Log))
    [System.Windows.Forms.MessageBox]::Show('Da sao chep nhat ky vao clipboard.', 'OK') | Out-Null
})

$panel.Controls.AddRange(@($btnClose, $btnView, $btnCopy))
$form.Controls.Add($panel)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
    if (-not (Test-Path $StatusFile)) { return }
    # Get-Content's default encoding on Windows PowerShell 5.1 is the system codepage, not UTF-8 —
    # since the .exe (via Node) always writes this file as UTF-8, reading it any other way mangles
    # the Vietnamese text. Read the bytes and decode explicitly instead.
    try { $s = [System.IO.File]::ReadAllText($StatusFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return }
    $pct = [Math]::Min([Math]::Max([int]$s.percent, 0), 100)
    $fill.Width = [int]($track.Width * $pct / 100)
    $label.Text = $s.label
    if ($s.done) {
        $timer.Stop()
        $script:LogPath = $s.logPath
        $track.Visible = $false
        $label.Visible = $false
        $heading.Text = if ($s.ok) { 'Da cai xong' } else { 'Cai dat gap loi' }
        $heading.ForeColor = if ($s.ok) { $TEAL } else { [System.Drawing.Color]::FromArgb(196, 68, 63) }
        $msg.Text = $s.message
        $msg.Visible = $true
        $panel.Visible = $true
        $form.Activate()
    }
})
$timer.Start()
$form.Add_Shown({
    $form.Activate()
    # Proof of life for the installer: this window is the only thing that can say PowerShell really
    # ran here. On a locked-down machine the whole script can be refused before it draws anything,
    # and every layer between (hidden wscript, detached process, GUI-subsystem exe) hides the error.
    try { New-Item -ItemType File -Force -Path (Join-Path (Split-Path $StatusFile -Parent) 'ready.marker') | Out-Null } catch { }
})
[System.Windows.Forms.Application]::Run($form)

# This script and its status file live in a per-run temp dir (see startProgress() below) that
# nothing else ever cleans up — the installer process that created it is long gone by the time the
# user closes this window, so this detached script is the only thing left that still knows its own
# directory and the right moment (after the window closes, not before) to remove it.
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
/** Blocks until the window reports itself up, or gives up. The spawn succeeding proves nothing —
 * it succeeds just as well when the thing spawned is then refused by policy, which is how an
 * install ended with no window and no error at all. */
function waitForReady(dir: string, timeoutMs: number): boolean {
    const marker = path.join(dir, "ready.marker");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !fs.existsSync(marker)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return fs.existsSync(marker);
}

export function startProgress(title: string): void {
    if (process.platform !== "win32") return;
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nivris-progress-"));
        statusFile = path.join(dir, "status.json");
        writeStatus({ percent: 0, label: "Dang chuan bi...", done: false });

        // mshta first, PowerShell second. mshta is a separate scripting engine under separate
        // policy, so it still runs on machines that refuse PowerShell scripts — and those are
        // exactly the machines this window was invisible on. It also renders with HTML/CSS, which
        // is what the design actually wants.
        const htaFile = path.join(dir, "progress.hta");
        fs.writeFileSync(
            htaFile,
            HTA_HTML.replace("__LOGO_B64__", LOGO_PNG_BASE64)
                .replace("__STATUS_FILE__", statusFile.replace(/\\/g, "\\\\"))
                .replace("__TITLE__", title),
            "utf8",
        );
        try {
            spawn("mshta.exe", [htaFile], { stdio: "ignore", windowsHide: false, detached: true }).unref();
            if (waitForReady(dir, 4000)) return;
        } catch {
            // fall through to the PowerShell window
        }

        const scriptFile = path.join(dir, "progress.ps1");
        writeUtf8Bom(scriptFile, PS_SCRIPT.replace("__LOGO_B64__", LOGO_PNG_BASE64));

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
        // detached + unref so the progress window outlives this process's own exit, which is the
        // whole point of it — finish() writes the final status and quits while the window is still
        // up to show it.
        spawn("wscript.exe", ["//B", "//NoLogo", vbsFile], {
            stdio: "ignore",
            windowsHide: true,
            detached: true,
        }).unref();
        if (!waitForReady(dir, 3000)) {
            // Neither engine produced a window: nothing can draw a progress UI here, and finish()
            // must not try to draw its result dialog with PowerShell either.
            statusFile = null;
            powershellUsable = false;
        }
    } catch {
        // PowerShell/WScript missing or unspawnable — fall back to no progress window at all;
        // finish() still needs to show *something*, handled by its own fallback when statusFile is null.
        statusFile = null;
        powershellUsable = false;
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
export function endProgress(ok: boolean, message: string, logPath?: string | null): void {
    writeStatus({ percent: 100, label: "", done: true, ok, message, logPath: logPath ?? undefined });
}
