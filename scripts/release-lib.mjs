// Pure helpers for the release workflow (.github/workflows/release.yml), kept
// separate from the CLI wrappers so they can be unit-tested.
import fs from "node:fs";
import path from "node:path";

/** Publish order: each package after everything it depends on. */
export const PUBLISH_ORDER = [
  "packages/registry",
  "packages/runtime",
  "packages/adapters",
  "packages/core",
  "apps/cli",
];

/** "v1.2.3" or "v1.2.3-rc.1" -> { version, prerelease }. Anything else throws. */
export function parseTag(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? "");
  if (!match) {
    throw new Error(`Tag "${tag}" must look like v1.2.3 or v1.2.3-rc.1.`);
  }
  return { version: match[1], prerelease: match[1].includes("-") };
}

function readPackage(root, dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8"));
  return { dir, name: pkg.name, version: pkg.version, private: pkg.private === true };
}

/** Every publishable (non-private) package under apps/* and packages/*. */
export function findPublishablePackageDirs(root) {
  const found = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = path.join(root, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir)) {
      const manifest = path.join(groupDir, entry, "package.json");
      if (!fs.existsSync(manifest)) continue;
      const dir = `${group}/${entry}`;
      if (!readPackage(root, dir).private) found.push(dir);
    }
  }
  return found.sort();
}

/**
 * Returns a list of problems (empty = safe to publish): the tag must equal the
 * version of every package we publish, and no publishable package may be
 * missing from PUBLISH_ORDER.
 */
export function checkRelease(root, tag) {
  const errors = [];
  let parsed;
  try {
    parsed = parseTag(tag);
  } catch (error) {
    return { errors: [error.message] };
  }
  for (const dir of PUBLISH_ORDER) {
    const pkg = readPackage(root, dir);
    if (pkg.private) errors.push(`${pkg.name} (${dir}) is private but listed for publishing.`);
    if (pkg.version !== parsed.version) {
      errors.push(`${pkg.name} is at ${pkg.version} but the tag is ${tag}. Bump it to ${parsed.version} and re-tag.`);
    }
  }
  for (const dir of findPublishablePackageDirs(root)) {
    if (!PUBLISH_ORDER.includes(dir)) {
      errors.push(`${dir} is publishable but missing from PUBLISH_ORDER in scripts/release-lib.mjs.`);
    }
  }
  return { errors, ...parsed };
}
