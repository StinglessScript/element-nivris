/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { fileURLToPath } from "node:url";
import { defineConfig, esmExternalRequirePlugin } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { importCSSSheet } from "@arcmantle/vite-plugin-import-css-sheet";
import externalGlobals from "rollup-plugin-external-globals";

// Inlined from @element-hq/element-web-module-api/vite.base.ts rather than imported: Node's
// native TS type-stripping refuses to load a .ts file that lives under node_modules, which broke
// `vite build` for this module once it moved out of the element-web pnpm workspace (where vite's
// own config bundler, not Node's loader, was handling it).
export default defineConfig({
    build: {
        outDir: "lib",
        target: "esnext",
        sourcemap: true,
        lib: {
            entry: fileURLToPath(import.meta.resolve("./src/index.tsx")),
            name: "element-web-module-nivris",
            fileName: "index",
            formats: ["es"],
        },
        rolldownOptions: {
            plugins: [esmExternalRequirePlugin({ external: ["react"] })],
            output: { globals: { react: "window.React" } },
        },
    },
    plugins: [
        importCSSSheet(),
        // Classic runtime (React.createElement) avoids importing "react/jsx-runtime", which isn't
        // externalized (only "react" itself maps to window.React).
        react({ jsxRuntime: "classic" }),
        nodePolyfills({ include: ["events"] }),
        externalGlobals({ react: "window.React" }),
    ],
    define: {
        "process.env.NODE_ENV": "'production'",
        process: { env: { NODE_ENV: "production" } },
        // Baked in by scripts/install-nivris.mjs at build time — the module has no filesystem access
        // to read these at runtime otherwise. See src/nivris/NivrisUpdateChecker.ts (uses the token
        // to authenticate to the local update helper) and scripts/nivris-update-helper.mjs.
        __NIVRIS_UPDATE_TOKEN__: JSON.stringify(process.env.NIVRIS_UPDATE_TOKEN ?? ""),
        __NIVRIS_UPDATE_PORT__: JSON.stringify(process.env.NIVRIS_UPDATE_PORT ?? "47291"),
    },
});
