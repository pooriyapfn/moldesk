#!/usr/bin/env node
// Builds the cloud worker release bundle: worker.tgz containing worker/main.js (a single bundled
// ESM file) and worker/models/ (the registry manifests the worker is allowed to run), plus
// worker.tgz.sha256. The client fetches the bundle by URL and verifies this SHA-256 before running it.
//
//   pnpm --filter @moldesk/core build:worker [-- --out <dir>]
//
// The bundle is a release artifact: publish it, record its URL and checksum in
// src/cloud/worker-release.ts, and validate it on a clean worker image before enabling cloud runs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outFlag = process.argv.indexOf("--out");
const outDir = path.resolve(outFlag > -1 ? process.argv[outFlag + 1] : path.join(root, "build", "worker-release"));
const stage = path.join(outDir, "stage");
const modelsSource = path.resolve(root, "..", "..", "models");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, "worker", "models"), { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "cloud", "worker", "main.ts")],
  outfile: path.join(stage, "worker", "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Native/keyring modules are loaded lazily by the client only; the worker never needs them.
  external: ["better-sqlite3", "@napi-rs/keyring"],
  banner: { js: "import { createRequire as __moldeskCreateRequire } from 'node:module';\nconst require = __moldeskCreateRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});

for (const entry of fs.readdirSync(modelsSource, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = path.join(modelsSource, entry.name, "manifest.yaml");
  if (!fs.existsSync(manifest)) continue;
  fs.mkdirSync(path.join(stage, "worker", "models", entry.name), { recursive: true });
  fs.copyFileSync(manifest, path.join(stage, "worker", "models", entry.name, "manifest.yaml"));
}

const archive = path.join(outDir, "worker.tgz");
// -n on gzip and fixed ownership keep the archive stable across rebuilds of identical inputs.
execFileSync("tar", ["--no-xattrs", "-cf", path.join(outDir, "worker.tar"), "-C", stage, "worker"], { stdio: "inherit" });
execFileSync("gzip", ["-n", "-f", path.join(outDir, "worker.tar")], { stdio: "inherit" });
fs.renameSync(path.join(outDir, "worker.tar.gz"), archive);
fs.rmSync(stage, { recursive: true, force: true });

const sha256 = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(`${archive}.sha256`, `${sha256}  worker.tgz\n`);
console.log(`${archive}\nsha256 ${sha256}\nsize ${fs.statSync(archive).size} bytes`);
