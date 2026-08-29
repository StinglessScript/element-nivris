/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import type { Api } from "@element-hq/element-web-module-api";

// The `Api` instance is only handed to NivrisModule.load() (src/index.tsx) — this stashes it so
// components/other modules that aren't part of that class (NivrisWorkspace.tsx, etc.) can still
// reach api.navigation and friends, same "module-level singleton getter" pattern as
// matrixClient.ts's getMatrixClient().
let moduleApi: Api | null = null;

export function setModuleApi(api: Api): void {
    moduleApi = api;
}

export function getModuleApi(): Api {
    if (!moduleApi) {
        throw new Error("Module API not set yet — NivrisModule.load() hasn't run");
    }
    return moduleApi;
}
