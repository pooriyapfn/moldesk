// Validates every models/*/manifest.yaml against the built v1 schema and copies
// the validated files into dist/models/ so the published package is self-contained.
// Run after tsc: `tsc -p tsconfig.json && node scripts/copy-manifests.mjs`.
// Fails on duplicate names, invalid schemas, or unsafe paths. Adapter registration
// is validated from compiled exports by @moldesk/adapters after this package builds.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pkgDir, "../..");
const sourceModelsDir = path.join(repoRoot, "models");
const outDir = path.join(pkgDir, "dist", "models");

const { loadManifestFile } = await import("../dist/loader.js");

const entries = fs.existsSync(sourceModelsDir)
  ? fs.readdirSync(sourceModelsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  : [];
if (entries.length === 0) {
  console.error(`No models found in ${sourceModelsDir}`);
  process.exit(1);
}

const seen = new Set();
fs.rmSync(outDir, { recursive: true, force: true });

for (const entry of entries) {
  const manifestPath = path.join(sourceModelsDir, entry.name, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = loadManifestFile(manifestPath); // throws typed INVALID_MANIFEST / UNKNOWN_SCHEMA_VERSION
  if (seen.has(manifest.name)) {
    console.error(`Duplicate model id "${manifest.name}" in ${manifestPath}`);
    process.exit(1);
  }
  seen.add(manifest.name);
  if (manifest.name !== entry.name) {
    console.error(`Manifest name "${manifest.name}" does not match directory "${entry.name}" (${manifestPath})`);
    process.exit(1);
  }
  const destDir = path.join(outDir, entry.name);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(destDir, "manifest.yaml"));
  console.log(`validated+copied ${manifest.name}`);
}

console.log(`Registry manifests: ${seen.size} model(s) -> dist/models/`);
