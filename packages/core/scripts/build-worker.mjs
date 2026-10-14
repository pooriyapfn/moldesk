#!/usr/bin/env node
// Builds the cloud worker release bundle: worker.tar containing worker/main.js (a single bundled
// ESM file) and worker/models/ (the registry manifests the worker is allowed to run), plus
// worker.tar.sha256. The client fetches the bundle by URL and verifies this SHA-256 before running it.
//
//   pnpm --filter @moldesk/core build:worker [-- --out <dir>]
//
// The bundle is a release artifact: publish it, record its URL and checksum in
// src/cloud/worker-release.ts, and validate it on a clean worker image before enabling cloud runs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// main.js is an ES module; without this marker Node treats it as CommonJS and dies on the first import.
fs.writeFileSync(path.join(stage, "worker", "package.json"), '{ "private": true, "type": "module" }\n');
// Loadable as the worker will load it: a syntax or module-type error must fail the build, not a paid Pod.
execFileSync(process.execPath, ["--check", path.join(stage, "worker", "main.js")], { stdio: "inherit" });

for (const entry of fs.readdirSync(modelsSource, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = path.join(modelsSource, entry.name, "manifest.yaml");
  if (!fs.existsSync(manifest)) continue;
  fs.mkdirSync(path.join(stage, "worker", "models", entry.name), { recursive: true });
  fs.copyFileSync(manifest, path.join(stage, "worker", "models", entry.name, "manifest.yaml"));
}

// A plain ustar archive written here, not tar/gzip from the host: the bytes depend only on the file
// contents (sorted names, zeroed timestamps and owners, no compression), so the same sources give
// the same SHA-256 on every machine and CI can check the checksum recorded in worker-release.ts.
function ustar(files) {
  const blocks = [];
  const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";
  for (const { name, data } of files) {
    if (Buffer.byteLength(name) > 100) throw new Error(`worker path too long for ustar: ${name}`);
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(octal(0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(data.length, 12), 124);
    header.write(octal(0, 12), 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function collect(dir, prefix) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    const name = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? collect(full, name) : [{ name, data: fs.readFileSync(full) }];
  });
}

const archive = path.join(outDir, "worker.tar");
fs.writeFileSync(archive, ustar(collect(path.join(stage, "worker"), "worker").sort((a, b) => (a.name < b.name ? -1 : 1))));
fs.rmSync(stage, { recursive: true, force: true });

const sha256 = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(`${archive}.sha256`, `${sha256}  worker.tar\n`);
console.log(`${archive}\nsha256 ${sha256}\nsize ${fs.statSync(archive).size} bytes`);
