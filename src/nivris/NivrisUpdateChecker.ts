/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Checks whether a newer Nivris commit exists than the one this module was built from. Purely a
// notification — the module has no filesystem/process access to apply an update itself (see
// scripts/install-nivris.mjs's comments), so the banner just tells the user to re-run the install
// command; it can't do it for them.

const REPO = "StinglessScript/element-nivris";
const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = "mx_nivris_update_check_cache";

export const INSTALL_COMMAND = `npx -y -p github:${REPO} nivris-install`;

export type NivrisUpdateState = { kind: "up-to-date" } | { kind: "new-version" } | { kind: "unknown" };

interface CachedCheck {
    ts: number;
    state: NivrisUpdateState;
}

async function fetchLatestSha(): Promise<string | null> {
    try {
        // api.github.com sets permissive CORS on its public GET endpoints (unlike
        // github.com/.../releases/.../download/..., which redirects to Azure Blob Storage with no
        // Access-Control-Allow-Origin header and silently fails a browser fetch()).
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

function writeCache(state: NivrisUpdateState): void {
    try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), state }));
    } catch {
        // best-effort cache — a failed write just means the next check isn't throttled
    }
}

/** The commit this running module was built from — "unknown" if install-nivris.mjs couldn't
 * resolve one (see its currentGitSha() for when that happens). */
export function getInstalledSha(): string {
    return __NIVRIS_BUILD_SHA__;
}

/** Checks (throttled to once per CHECK_THROTTLE_MS, unless `force`) whether a newer commit than
 * the one this module was built from exists on GitHub. */
export async function getUpdateState(force = false): Promise<NivrisUpdateState> {
    const cached = readCache();
    if (!force && cached && Date.now() - cached.ts < CHECK_THROTTLE_MS) return cached.state;

    const installedSha = getInstalledSha();
    if (installedSha === "unknown") {
        const state: NivrisUpdateState = { kind: "unknown" };
        writeCache(state);
        return state;
    }

    const latestSha = await fetchLatestSha();
    const state: NivrisUpdateState = latestSha && latestSha !== installedSha ? { kind: "new-version" } : { kind: "up-to-date" };
    writeCache(state);
    return state;
}
