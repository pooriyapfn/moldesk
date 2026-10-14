#!/usr/bin/env node
// Keeps the worker bundle recorded in packages/core/src/cloud/worker-release.ts in step with the sources.
//
//   node scripts/worker-release.mjs check  [--tag vX.Y.Z] [--require]
//   node scripts/worker-release.mjs update  --tag vX.Y.Z
//
// The bundle (worker.tar) is built deterministically from packages/core and models/, so its SHA-256 only
// changes when the worker code or a model manifest does. `check` rebuilds it and fails when the recorded
// checksum is stale; with --tag it also requires the recorded URL to be that release's asset, and with
// --require it fails when no bundle is recorded at all. `update` rewrites the constant for a release.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseFile = path.join(root, "packages", "core", "src", "cloud", "worker-release.ts");
const REPO = "pooriyapfn/moldesk";
const CONSTANT = /export const RELEASED_WORKER_BUNDLE: WorkerBundle \| undefined =[\s\S]*?;\n/;

export function assetUrl(tag) {
  return `https://github.com/${REPO}/releases/download/${tag}/worker.tar`;
}

export function buildBundle(outDir) {
  execFileSync("pnpm", ["--filter", "@moldesk/core", "build:worker", "--", "--out", outDir], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  return fs.readFileSync(path.join(outDir, "worker.tar.sha256"), "utf8").split(/\s+/)[0];
}

export function readRecorded(source = fs.readFileSync(releaseFile, "utf8")) {
  const block = source.match(CONSTANT)?.[0] ?? "";
  const url = block.match(/url:\s*"([^"]+)"/)?.[1];
  const sha256 = block.match(/sha256:\s*"([0-9a-f]{64})"/)?.[1];
  return url && sha256 ? { url, sha256 } : undefined;
}

export function render(source, bundle) {
  const body = bundle ? `{\n  url: "${bundle.url}",\n  sha256: "${bundle.sha256}",\n};\n` : "undefined;\n";
  return source.replace(CONSTANT, `export const RELEASED_WORKER_BUNDLE: WorkerBundle | undefined = ${body}`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => {
    const index = rest.indexOf(name);
    return index === -1 ? undefined : rest[index + 1] ?? "";
  };
  const tag = flag("--tag");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-worker-"));
  try {
    const built = buildBundle(out);
    const recorded = readRecorded();
    if (command === "update") {
      if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("update needs --tag vX.Y.Z");
      fs.writeFileSync(releaseFile, render(fs.readFileSync(releaseFile, "utf8"), { url: assetUrl(tag), sha256: built }));
      console.log(`Recorded ${assetUrl(tag)}\n  sha256 ${built}`);
      return;
    }
    if (command !== "check") throw new Error("usage: worker-release.mjs check|update [--tag vX.Y.Z] [--require]");
    if (!recorded) {
      if (rest.includes("--require")) throw new Error("No worker bundle is recorded in worker-release.ts. Run: node scripts/worker-release.mjs update --tag <tag>");
      console.log(`No worker bundle recorded yet (built sha256 ${built}); cloud runs stay disabled.`);
      return;
    }
    if (recorded.sha256 !== built) {
      throw new Error(`worker-release.ts records sha256 ${recorded.sha256} but the sources build ${built}. The worker code or a model manifest changed: run node scripts/worker-release.mjs update --tag <release tag> and commit the result.`);
    }
    if (tag && recorded.url !== assetUrl(tag)) {
      throw new Error(`worker-release.ts points at ${recorded.url}, expected ${assetUrl(tag)}. Run: node scripts/worker-release.mjs update --tag ${tag}`);
    }
    console.log(`Worker bundle ${recorded.sha256} matches the sources${tag ? ` and ${tag}` : ""}.`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
