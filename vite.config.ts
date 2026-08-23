/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { importCSSSheet } from "@arcmantle/vite-plugin-import-css-sheet";
import baseConfig from "@element-hq/element-web-module-api/vite.base.ts";

export default mergeConfig(baseConfig, {
    build: {
        lib: {
            entry: fileURLToPath(import.meta.resolve("./src/index.tsx")),
            name: "element-web-module-nivris",
            fileName: "index",
            formats: ["es"],
        },
    },
    plugins: [
        importCSSSheet(),
        // Classic runtime (React.createElement) avoids importing "react/jsx-runtime", which the
        // base config doesn't externalize (only "react" itself maps to window.React).
        react({ jsxRuntime: "classic" }),
        nodePolyfills({
            include: ["events"],
        }),
    ],
});
