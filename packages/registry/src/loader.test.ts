import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { MoldeskError } from "./errors.js";
import { listAvailableModels } from "./loader.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeManifest(dir: string, name: string, overrides: Record<string, unknown> = {}): void {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    name,
    displayName: name,
    modelVersion: "1.0.0",
    adapterVersion: "0.1.0",
    description: `${name} model`,
    category: "other",
    status: "beta",
    runtimes: [{ kind: "python", python: "3.11", installer: "uv", requirements: [{ name: "torch" }] }],
    hardware: {},
    input: { formats: [".pdb"], required: true },
    outputs: [{ id: "out", glob: "*.txt", required: true }],
    ...overrides,
  };
  const modelDir = path.join(dir, name);
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, "manifest.yaml"), YAML.stringify(base));
}

describe("listAvailableModels", () => {
  it("discovers validated manifests sorted by name", () => {
    const dir = makeTempDir("moldesk-registry-");
    writeManifest(dir, "zebra");
    writeManifest(dir, "alpha");
    const models = listAvailableModels(dir);
    expect(models.map((m) => m.name)).toEqual(["alpha", "zebra"]);
  });

  it("throws DUPLICATE_MODEL_ID on duplicate names", () => {
    const dir = makeTempDir("moldesk-dup-");
    writeManifest(dir, "dir-a", { name: "same" });
    writeManifest(dir, "dir-b", { name: "same" });
    try {
      listAvailableModels(dir);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MoldeskError);
      expect((error as MoldeskError).code).toBe("DUPLICATE_MODEL_ID");
    }
  });

  it("loads default manifests relative to the module, not cwd", () => {
    const originalCwd = process.cwd();
    const unrelatedCwd = makeTempDir("moldesk-unrelated-cwd-");
    try {
      process.chdir(unrelatedCwd);
      const models = listAvailableModels();
      const names = models.map((m) => m.name).sort();
      expect(names).toEqual(["boltz", "ligandmpnn", "proteinmpnn"]);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
