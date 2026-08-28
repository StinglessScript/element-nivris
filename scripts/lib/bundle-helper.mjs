/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Bundles nivris-update-helper.mjs (plus its ./lib/* imports and their npm dependencies, notably
// @electron/asar) into a single self-contained .mjs file with no external node_modules resolution
// needed at runtime. Used by installHelperFiles() so the persistent background helper — copied to
// a stable location outside the repo/npx checkout that produced it — can extract a fresh
// webapp.asar on its own (e.g. after Element's own auto-updater wipes the patch back to stock)
// without shelling out to `npx` to fetch a whole new environment, which requires Node/npm on the
// end user's machine. The standalone (Bun-compiled) installer already gets this for free from
// `bun build --compile`; this gives the plain-Node `nivris-install` path the same property.

import { rollup } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";

export async function bundleHelperScript(entryPath, outFile) {
    const bundle = await rollup({
        input: entryPath,
        plugins: [nodeResolve({ preferBuiltins: true })],
        external: (id) => id.startsWith("node:"),
        onwarn: () => {}, // circular-dependency / eval warnings from transitive deps are not actionable here
    });
    try {
        await bundle.write({ file: outFile, format: "esm", inlineDynamicImports: true });
    } finally {
        await bundle.close();
    }
}
