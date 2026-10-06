#!/usr/bin/env node
// Usage: node scripts/publish-package.mjs <package-dir> [--dry-run]
// Publishes one workspace package to npm unless that exact version is already
// there, so a failed release run can be safely re-run. Prerelease versions are
// published under the "next" dist-tag so they never become "latest".
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!dir) {
  console.error("Usage: node scripts/publish-package.mjs <package-dir> [--dry-run]");
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8"));
const spec = `${pkg.name}@${pkg.version}`;

function alreadyPublished() {
  const view = spawnSync("npm", ["view", spec, "version"], { encoding: "utf8" });
  if (view.status === 0) return view.stdout.trim() === pkg.version;
  // A missing version or a never-published package is E404; anything else (network,
  // auth) must stop the release rather than risk a wrong decision.
  if (/E404|404 Not Found/.test(`${view.stderr}${view.stdout}`)) return false;
  console.error(`::error::Could not check npm for ${spec}:\n${view.stderr}`);
  process.exit(1);
}

if (alreadyPublished()) {
  console.log(`${spec} is already on npm; skipping.`);
  process.exit(0);
}

const args = ["publish", "--no-git-checks", "--access", "public"];
if (pkg.version.includes("-")) args.push("--tag", "next");
console.log(`${dryRun ? "[dry run] would run" : "Running"}: pnpm ${args.join(" ")}  (${spec})`);
if (!dryRun) execFileSync("pnpm", args, { cwd: path.join(root, dir), stdio: "inherit" });
