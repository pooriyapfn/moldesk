#!/usr/bin/env node
// Usage: node scripts/release-check.mjs <tag>
// Fails (exit 1) unless the tag matches every published package's version.
// When running in GitHub Actions, also writes `version` and `prerelease` outputs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease } from "./release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2];
const result = checkRelease(root, tag);

if (result.errors.length > 0) {
  for (const message of result.errors) console.error(`::error::${message}`);
  process.exit(1);
}
console.log(`Release ${tag}: all packages are at ${result.version}${result.prerelease ? " (prerelease, will publish under the \"next\" tag)" : ""}.`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\nprerelease=${result.prerelease}\n`);
}
