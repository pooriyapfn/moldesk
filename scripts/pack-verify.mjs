// Step 1 packaging gate: packs every published workspace package, installs those
// tarballs into an unrelated temporary project, and runs the installed CLI binary.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-pack-verify-"));
const packDir = path.join(tmp, "packs");
const installDir = path.join(tmp, "installed-project");
const unrelatedCwd = path.join(tmp, "unrelated-working-directory");

try {
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(unrelatedCwd, { recursive: true });

  execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });

  const packageDirs = [
    "packages/registry",
    "packages/runtime",
    "packages/adapters",
    "packages/core",
    "apps/cli",
  ];
  for (const packageDir of packageDirs) {
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: path.join(repoRoot, packageDir),
      stdio: "inherit",
    });
  }

  const tarballs = fs
    .readdirSync(packDir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => path.join(packDir, name));
  if (tarballs.length !== packageDirs.length) {
    throw new Error(`Expected ${packageDirs.length} package tarballs; found ${tarballs.length}.`);
  }

  fs.writeFileSync(
    path.join(installDir, "package.json"),
    `${JSON.stringify({ name: "moldesk-pack-verification", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    { cwd: installDir, stdio: "inherit" },
  );

  const installedRegistryModels = path.join(
    installDir,
    "node_modules",
    "@moldesk",
    "registry",
    "dist",
    "models",
  );
  const manifests = fs
    .readdirSync(installedRegistryModels, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expected = ["boltz", "ligandmpnn", "proteinmpnn"];
  if (manifests.join(",") !== expected.join(",")) {
    throw new Error(`Expected installed registry manifests ${expected.join(",")}; found ${manifests.join(",")}.`);
  }

  const cliBin = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "moldesk.cmd" : "moldesk",
  );
  const output = execFileSync(cliBin, ["list"], { cwd: unrelatedCwd, encoding: "utf-8" });
  for (const name of expected) {
    if (!output.includes(name)) {
      throw new Error(`Installed moldesk list is missing model "${name}". Output:\n${output}`);
    }
  }

  console.log(`Installed package manifests OK: ${manifests.join(", ")}`);
  console.log("Installed moldesk CLI works from an unrelated cwd.");
  console.log("pack:verify passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
