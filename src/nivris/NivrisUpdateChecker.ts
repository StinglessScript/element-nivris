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
    /** The installed SHA this result was computed against — if the helper now reports a different
     * one (an update just landed, e.g. Element was just relaunched after applying it), the cache is
     * stale regardless of how recently it was written. Without this, a successful update leaves the
     * fresh post-relaunch banner reading the pre-update "new-version" verdict straight out of cache
     * until the throttle window happens to expire or someone force-checks. */
    sha: string | null;
}

function authHeaders(): Record<string, string> {
    return { "X-Nivris-Token": __NIVRIS_UPDATE_TOKEN__ };
}

const FETCH_TIMEOUT_MS = 8000;

/** Plain fetch() never times out on its own — if the helper is up but wedged (seen for real right
 * after a Windows self-update: Element relaunches, the renderer starts polling immediately, and
 * something in that window leaves the request just hanging with no response), every caller here
 * awaiting it directly would hang forever too, which is exactly what "Đang kiểm tra..." getting
 * stuck meant — a `finally` block never runs on a promise that never settles. AbortController gives
 * every one of these calls a hard ceiling so the UI always recovers into some real state. */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        window.clearTimeout(timer);
    }
}

async function fetchHelperStatus(): Promise<HelperStatus | null> {
    try {
        const res = await fetchWithTimeout(`${HELPER_BASE}/status`, { headers: authHeaders() });
        if (!res.ok) return null;
        return (await res.json()) as HelperStatus;
    } catch {
        return null;
    }
}

async function fetchLatestSha(): Promise<string | null> {
    try {
        // NOT github.com/.../releases/latest/download/nivris-version.json (what the helper actually
        // downloads) — that redirects to Azure Blob Storage, whose response has no
        // Access-Control-Allow-Origin header, so a browser fetch() from this renderer context
        // silently fails (caught below, indistinguishable from "offline"). api.github.com sets
        // "access-control-allow-origin: *" on its public GET endpoints, so use that instead.
        //
        // NOT commits/main either, despite also being CORS-fine — that reflects the instant a
        // commit is pushed, well before the release workflow (a few minutes) actually finishes
        // publishing new assets built from it. Comparing against git HEAD directly raced the
        // in-app "update available" banner ahead of there being anything new to download: push
        // lands, banner immediately claims an update, but clicking it just re-downloads the
        // still-current build (CI isn't done yet) and reapplies the same SHA, looking stuck in a
        // loop until CI catches up minutes later. The release's own `name` field only changes once
        // the publish job's final step actually runs — see release.yml's matching comment — so it
        // tracks what's truly downloadable right now, not what's merely been committed.
        const res = await fetchWithTimeout(`https://api.github.com/repos/${REPO}/releases/latest`);
        if (!res.ok) return null;
        const data = (await res.json()) as { name?: unknown };
        const match = typeof data.name === "string" ? /\b([0-9a-f]{40})\b/.exec(data.name) : null;
        return match ? match[1] : null;
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

function writeCache(state: NivrisUpdateState, sha: string | null): void {
    try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), state, sha }));
    } catch {
        // best-effort cache — a failed write just means the next check isn't throttled
    }
    listeners.forEach((l) => l(state));
}

/** Checks whether an update is available. The helper call (local, no rate limit) always runs
 * fresh; only the GitHub lookup (rate-limited) is throttled to once per CHECK_THROTTLE_MS — and
 * even that's skipped if the installed SHA has changed since the cached result, which is what
 * makes a just-applied update reflect immediately on the very next check instead of waiting out
 * the throttle window or requiring a manual force-check. */
export async function getUpdateState(force = false): Promise<NivrisUpdateState> {
    const status = await fetchHelperStatus();
    if (!status?.helperRunning) {
        const state: NivrisUpdateState = { kind: "helper-unreachable" };
        writeCache(state, null);
        return state;
    }
    if (!status.patched) {
        const state: NivrisUpdateState = { kind: "patch-missing" };
        writeCache(state, status.currentSha);
        return state;
    }

    // "unknown" is a real value install-nivris.mjs can write (couldn't resolve its own commit) —
    // treat it like "no data" rather than let it always mismatch and false-flag every such install.
    const knownCurrentSha = status.currentSha && status.currentSha !== "unknown" ? status.currentSha : null;

    const cached = readCache();
    if (!force && cached && cached.sha === knownCurrentSha && Date.now() - cached.ts < CHECK_THROTTLE_MS) {
        return cached.state;
    }

    const latestSha = await fetchLatestSha();
    const state: NivrisUpdateState =
        latestSha && knownCurrentSha && latestSha !== knownCurrentSha ? { kind: "new-version" } : { kind: "up-to-date" };
    writeCache(state, knownCurrentSha);
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
    try {
        await fetchWithTimeout(`${HELPER_BASE}/update`, { method: "POST", headers: authHeaders() });
    } catch {
        // best-effort kickoff — the caller's progress poll (fetchUpdateProgress) is what actually
        // drives the UI, and it fails closed (null) on its own if nothing ever started
    }
}

export async function fetchUpdateProgress(): Promise<UpdateProgress | null> {
    try {
        const res = await fetchWithTimeout(`${HELPER_BASE}/update/progress`, { headers: authHeaders() });
        if (!res.ok) return null;
        return (await res.json()) as UpdateProgress;
    } catch {
        return null;
    }
}
