import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMoldeskPaths, type MoldeskPaths } from "@moldesk/runtime";
import { USALIGN_CITATION, USALIGN_VERSION, usalignDir, type UsalignReceipt } from "../tools/usalign.js";

/** A MOLDESK_HOME under `dir`, optionally with a valid US-align installation record around a placeholder binary. */
export function usalignHome(dir: string, options: { installed?: boolean } = {}): MoldeskPaths {
  const paths = getMoldeskPaths({ MOLDESK_HOME: path.join(dir, "home") });
  if (options.installed) {
    const root = usalignDir(paths);
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const binary = path.join(root, "bin", "USalign");
    fs.writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const receipt: UsalignReceipt = {
      schemaVersion: 1,
      tool: "usalign",
      version: USALIGN_VERSION,
      commit: "0".repeat(40),
      source: { url: "https://example.test/usalign.tar.gz", sha256: "0".repeat(64) },
      compiler: { command: "c++", version: "test" },
      binary: { path: "bin/USalign", sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex") },
      platform: process.platform,
      arch: process.arch,
      installedAt: "2026-01-01T00:00:00.000Z",
      license: "test",
      citation: USALIGN_CITATION,
    };
    fs.writeFileSync(path.join(root, "installation.json"), JSON.stringify(receipt));
  }
  return paths;
}

const DATA = path.resolve(import.meta.dirname, "../analysis/testdata/usalign");

/** Real US-align 20260527 output captured with `-outfmt -1 -m - -het 2` (see testdata/usalign). */
export const captured = (name: string): string => fs.readFileSync(path.join(DATA, name), "utf8");

/** The rigid transform that was applied to 1CRN to make the "moved" copy the captures were taken with. */
export const APPLIED = {
  R: [[0.36, 0.48, -0.8], [-0.8, 0.6, 0], [0.48, 0.64, 0.6]],
  t: [10, -5, 3],
};
