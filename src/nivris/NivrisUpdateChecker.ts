/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Talks to the local nivris-update-helper (scripts/nivris-update-helper.mjs) to find out whether
// an update is available and to trigger one. The module itself has no filesystem/process access
// (see scripts/install-nivris.mjs's comments), so this is the only way it can ever apply an update.

const REPO = "StinglessScript/element-nivris";
const HELPER_BASE = `http://127.0.0.1:${__NIVRIS_UPDATE_PORT__}`;
const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = "mx_nivris_update_check_cache";

export type NivrisUpdateState =
    | { kind: "up-to-date" }
    | { kind: "new-version" }
    /** Element's own auto-updater wiped webapp.asar back to stock, taking the patch with it. */
    | { kind: "patch-missing" }
    /** No helper running yet — either it's not installed (pre-rollout install, needs one manual
     * `nivris-install` re-run once) or it crashed. Nothing actionable to show the user. */
    | { kind: "helper-unreachable" };

interface HelperStatus {
    helperRunning: boolean;
    patched: boolean;
    currentSha: string | null;
}

export interface UpdateProgress {
    percent: number;
    label: string;
    done: boolean;
    ok: boolean;
    message: string;
}

interface CachedCheck {
    ts: number;
    state: NivrisUpdateState;
}

function authHeaders(): Record<string, string> {
    return { "X-Nivris-Token": __NIVRIS_UPDATE_TOKEN__ };
}

async function fetchHelperStatus(): Promise<HelperStatus | null> {
    try {
        const res = await fetch(`${HELPER_BASE}/status`, { headers: authHeaders() });
        if (!res.ok) return null;
        return (await res.json()) as HelperStatus;
    } catch {
        return null;
    }
}

async function fetchLatestSha(): Promise<string | null> {
    try {
        // NOT the same URL the helper downloads from (github.com/.../releases/latest/download/...)
        // — that redirects to Azure Blob Storage, whose response has no
        // Access-Control-Allow-Origin header, so a browser fetch() from this renderer context
        // silently fails (caught below, indistinguishable from "offline"). api.github.com sets
        // "access-control-allow-origin: *" on its public GET endpoints, so use that instead just
        // for the version check; the helper's actual download (plain Node https, not subject to
        // CORS) is unaffected and keeps using the release asset.
        const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`);
        if (!res.ok) return null;
        const data = (await res.json()) as { sha?: unknown };
        return typeof data.sha === "string" ? data.sha : null;
    } catch {
        return null;
    }
}

function readCache(): CachedCheck | null {
    try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        return raw ? (JSON.parse(raw) as CachedCheck) : null;
    } catch {
        return null;
    }
}

// The floating banner (mounted once at app load) and the Settings panel's "Kiểm tra cập nhật
// ngay" button each call getUpdateState() independently — without this, a fresh result from one
// never reaches the other's already-rendered React state, so they can show contradictory info
// (Settings says "up to date" right after a check that the banner, still holding its stale
// from-mount state, keeps disagreeing with).
const listeners = new Set<(state: NivrisUpdateState) => void>();

export function subscribeUpdateState(listener: (state: NivrisUpdateState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function writeCache(state: NivrisUpdateState): void {
    try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), state }));
    } catch {
        // best-effort cache — a failed write just means the next check isn't throttled
    }
    listeners.forEach((l) => l(state));
}

/** Checks (throttled to once per CHECK_THROTTLE_MS, unless `force`) whether an update is
 * available. Combines the helper's live on-disk status with the latest published release SHA. */
export async function getUpdateState(force = false): Promise<NivrisUpdateState> {
    const cached = readCache();
    if (!force && cached && Date.now() - cached.ts < CHECK_THROTTLE_MS) return cached.state;

    const status = await fetchHelperStatus();
    if (!status?.helperRunning) {
        const state: NivrisUpdateState = { kind: "helper-unreachable" };
        writeCache(state);
        return state;
    }
    if (!status.patched) {
        const state: NivrisUpdateState = { kind: "patch-missing" };
        writeCache(state);
        return state;
    }

    const latestSha = await fetchLatestSha();
    // "unknown" is a real value install-nivris.mjs can write (couldn't resolve its own commit) —
    // treat it like "no data" rather than let it always mismatch and false-flag every such install.
    const knownCurrentSha = status.currentSha && status.currentSha !== "unknown" ? status.currentSha : null;
    const state: NivrisUpdateState =
        latestSha && knownCurrentSha && latestSha !== knownCurrentSha ? { kind: "new-version" } : { kind: "up-to-date" };
    writeCache(state);
    return state;
}

/** The commit currently installed, read straight from disk via the helper — not cached, always
 * live. Used by the Settings panel so the version shown there can't go stale like the throttled
 * getUpdateState() cache can. Null if the helper isn't reachable. */
export async function getInstalledSha(): Promise<string | null> {
    const status = await fetchHelperStatus();
    return status?.patched ? status.currentSha : null;
}

export async function triggerUpdate(): Promise<void> {
    await fetch(`${HELPER_BASE}/update`, { method: "POST", headers: authHeaders() });
}

export async function fetchUpdateProgress(): Promise<UpdateProgress | null> {
    try {
        const res = await fetch(`${HELPER_BASE}/update/progress`, { headers: authHeaders() });
        if (!res.ok) return null;
        return (await res.json()) as UpdateProgress;
    } catch {
        return null;
    }
}
