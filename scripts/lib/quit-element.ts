/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Best-effort: quits Element Desktop if it's currently running, before install/uninstall touches
// its files — avoids the EBUSY dance of asking the user to manually quit it (Element likes to
// minimize to the tray instead of exiting on window-close, which trips people up). Tries a graceful
// quit first, falls back to a forceful kill if it doesn't exit within a few seconds. Never throws —
// if it can't confirm Element is closed, the caller's existing EBUSY handling still catches that.

// windowsHide: true is load-bearing, not cosmetic — without it, every tasklist/taskkill spawned
// from this console-less compiled .exe gets its own new console window from Windows (nothing to
// attach to), which flashes on screen. isRunningWindows() alone gets called up to ~17 times while
// polling for Element to exit, so omitting this turns into a rapid strobe of console flashes.
function isRunningWindows(): boolean {
    try {
        const out = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq Element.exe", "/FO", "CSV", "/NH"], {
            stdout: "pipe",
            stderr: "ignore",
            windowsHide: true,
        });
        return new TextDecoder().decode(out.stdout).toLowerCase().includes("element.exe");
    } catch {
        return false;
    }
}

function isRunningMac(): boolean {
    try {
        return Bun.spawnSync(["pgrep", "-x", "Element"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
        return false;
    }
}

async function waitUntilClosed(isRunning: () => boolean, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (isRunning()) {
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return true;
}

/**
 * Quits Element if it's running. Returns true once confirmed closed (or it wasn't running to begin
 * with), false if it's still running after both the graceful and forceful attempts — the caller's
 * own EBUSY error path covers that case with instructions for the user to close it by hand.
 */
export async function quitElementIfRunning(onStatus?: (msg: string) => void): Promise<boolean> {
    if (process.platform === "win32") {
        if (!isRunningWindows()) return true;
        onStatus?.("Element đang chạy — đang tắt...");
        try {
            Bun.spawnSync(["taskkill", "/IM", "Element.exe", "/T"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
        } catch {
            // ignore — waitUntilClosed below decides whether this actually worked
        }
        if (await waitUntilClosed(isRunningWindows, 5000)) return true;
        try {
            Bun.spawnSync(["taskkill", "/IM", "Element.exe", "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
        } catch {
            // ignore
        }
        return waitUntilClosed(isRunningWindows, 5000);
    }

    if (process.platform === "darwin") {
        if (!isRunningMac()) return true;
        onStatus?.("Element đang chạy — đang tắt...");
        try {
            Bun.spawnSync(["osascript", "-e", 'tell application "Element" to quit'], { stdout: "ignore", stderr: "ignore" });
        } catch {
            // ignore
        }
        if (await waitUntilClosed(isRunningMac, 5000)) return true;
        try {
            Bun.spawnSync(["pkill", "-x", "Element"], { stdout: "ignore", stderr: "ignore" });
        } catch {
            // ignore
        }
        return waitUntilClosed(isRunningMac, 5000);
    }

    return true;
}
