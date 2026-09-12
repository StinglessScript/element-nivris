#!/usr/bin/env node
/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Builds the Windows installer/uninstaller as a Node Single Executable Application instead of a
// `bun build --compile` binary.
//
// Why not Bun on Windows: a Bun-compiled exe statically imports ClosePseudoConsole, a ConPTY API
// that only exists from Windows 10 1809 (build 17763). On anything older Windows refuses to LOAD
// the file — "Entry Point Not Found", before a single line of our code runs, so the program cannot
// detect the situation and fall back to anything. node.exe imports no ConPTY symbols at all, so a
// Node-hosted binary runs on those machines. It also comes out smaller (~70MB vs ~82MB).
//
// The host node.exe is whatever Node runs this script, and SEA blobs are version-locked to the
// runtime that generated them — so the workflow pins Node 20 for this job: it's the line that
// still supports the older Windows builds this exists to serve.
//
// Usage:  node scripts/build-sea-win.mjs <entry.ts> <out.exe>

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [entryArg, outArg] = process.argv.slice(2);
if (!entryArg || !outArg) {
    console.error("Usage: node scripts/build-sea-win.mjs <entry.ts> <out.exe>");
    process.exit(1);
}

const entry = path.resolve(root, entryArg);
const outFile = path.resolve(root, outArg);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nivris-sea-"));
const bundlePath = path.join(workDir, "bundle.js");
const blobPath = path.join(workDir, "sea.blob");
const configPath = path.join(workDir, "sea-config.json");

const builtModule = path.join(root, "lib/index.js");
if (!fs.existsSync(builtModule)) {
    console.error("[sea] lib/index.js chưa có — chạy `npm run build` trước.");
    process.exit(1);
}

// The entry imports the built module with Bun's `with { type: "file" }` attribute, which yields a
// path to an extracted temp file. esbuild doesn't understand that attribute, and Node SEA has no
// equivalent, so the import is rewritten to a generated module that carries the bytes inline and
// materialises them on first use — same contract (a real path on disk), no Bun.
const EMBED_SPECIFIER = "../lib/index.js";
// SEA entry points run as CommonJS, which rules out the top-level `await import(...)` the entry
// uses to load the helper only when re-invoked with --run-helper. Wrapping that one await in an
// async IIFE keeps the same behaviour (still dynamic, still only on that flag) in a CJS bundle.
const source = fs
    .readFileSync(entry, "utf-8")
    .replace(/\s+with\s*\{\s*type:\s*"file"\s*\}/g, "")
    .replace(
        /^(\s*)await import\((.*)\);$/m,
        (_m, indent, spec) => `${indent}void (async () => { await import(${spec}); })();`,
    );

const embedPlugin = {
    name: "nivris-embed-module",
    setup(b) {
        b.onResolve({ filter: /^\.\.\/lib\/index\.js$/ }, () => ({ path: EMBED_SPECIFIER, namespace: "nivris-embed" }));
        b.onLoad({ filter: /.*/, namespace: "nivris-embed" }, () => ({
            contents: `
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const BYTES = ${JSON.stringify(fs.readFileSync(builtModule).toString("base64"))};
// Written once per run, next to the other temp files this installer already uses. The consumer
// only ever reads it, so a stale file from a previous run is harmless to overwrite.
const target = path.join(os.tmpdir(), "nivris-embedded-module.js");
fs.writeFileSync(target, Buffer.from(BYTES, "base64"));
export default target;
`,
            loader: "js",
            resolveDir: root,
        }));
    },
};

const sha = process.env.NIVRIS_BUILD_SHA ?? "";

await build({
    stdin: { contents: source, resolveDir: path.dirname(entry), sourcefile: path.basename(entry), loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs", // SEA runs the blob as CommonJS
    outfile: bundlePath,
    plugins: [embedPlugin],
    define: {
        NIVRIS_BUILD_SHA: JSON.stringify(sha),
        // A CJS bundle has no import.meta. The only consumer is the update helper working out
        // which directory it lives in, and for a single-file executable that IS the executable's
        // own directory — which is also the fallback that code already uses when self-discovery
        // finds nothing, so this keeps the existing behaviour rather than inventing one.
        "import.meta.url": "__nivrisSelfUrl",
    },
    // Optional native dep of a transitive watcher; never loaded on Windows and not shippable here.
    external: ["fsevents"],
    legalComments: "none",
    // define only accepts an identifier or literal, so the expression lands in a banner and the
    // define points at it.
    banner: { js: "const __nivrisSelfUrl = require('node:url').pathToFileURL(process.execPath).href;" },
});

fs.writeFileSync(
    configPath,
    JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2),
);

console.log("[sea] Tạo blob…");
execFileSync(process.execPath, ["--experimental-sea-config", configPath], { stdio: "inherit" });

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.copyFileSync(process.execPath, outFile);

console.log("[sea] Inject blob vào node.exe…");
execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--yes", "postject", outFile, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"],
    { stdio: "inherit" },
);

fs.rmSync(workDir, { recursive: true, force: true });
const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
console.log(`[sea] Xong: ${outFile} (${mb} MB, Node ${process.version})`);
