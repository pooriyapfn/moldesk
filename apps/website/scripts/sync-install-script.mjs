// The website serves the installer at /install.sh from public/install.sh.
// scripts/install.sh at the repo root is the single source of truth; this copies
// it into public/ before every build and dev start. The copy is committed so a
// deploy that cannot see files outside apps/website still serves the installer.
//   node scripts/sync-install-script.mjs          copy (default)
//   node scripts/sync-install-script.mjs --check  exit 1 if the copy is stale
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../../../scripts/install.sh");
const target = path.resolve(here, "../public/install.sh");

if (!fs.existsSync(source)) {
  if (!fs.existsSync(target)) {
    console.error("install.sh is missing: neither scripts/install.sh nor public/install.sh exists.");
    process.exit(1);
  }
  console.log("scripts/install.sh not visible from here; keeping the committed public/install.sh.");
  process.exit(0);
}

const wanted = fs.readFileSync(source);
const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
const same = current !== null && wanted.equals(current);

if (process.argv.includes("--check")) {
  if (!same) {
    console.error("apps/website/public/install.sh is out of date. Run: pnpm --filter website sync:install");
    process.exit(1);
  }
  process.exit(0);
}

if (!same) {
  fs.writeFileSync(target, wanted, { mode: 0o644 });
  console.log("Updated public/install.sh from scripts/install.sh");
}
