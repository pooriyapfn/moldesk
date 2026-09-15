import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAvailableModels } from "@moldesk/registry";
import { adapterCatalog } from "./catalog.js";
import { validateParams } from "./params.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-contract-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const installableManifests = listAvailableModels().filter((manifest) => manifest.status !== "planned");

describe.each(installableManifests.map((manifest) => [manifest.name, manifest] as const))(
  "adapter contract: %s",
  (name, manifest) => {
    const adapter = adapterCatalog[name];

    it("is registered under its manifest name", () => {
      expect(adapter).toBeDefined();
      expect(adapter?.modelName).toBe(name);
    });

    it("rejects a missing input file", async () => {
      await expect(adapter!.validateInput(path.join(tempDir(), "does-not-exist"))).rejects.toBeDefined();
    });

    it("builds a well-formed CommandSpec with default params", async () => {
      const { effective } = validateParams(adapter!.params ?? [], {});
      const dir = tempDir();
      const spec = await adapter!.command({
        manifestName: name,
        inputPath: path.join(dir, "input"),
        outputDir: path.join(dir, "output"),
        modelDir: path.join(dir, "model"),
        assetsDir: path.join(dir, "model", "assets"),
        params: effective,
        runtimeExecutable: path.join(dir, "model", ".venv", "bin", "python"),
      });
      expect(spec.executable.length).toBeGreaterThan(0);
      expect(Array.isArray(spec.args)).toBe(true);
      expect(spec.args.length).toBeGreaterThan(0);
    });

    it("throws MISSING_REQUIRED_OUTPUT for an empty output directory when a required output is declared", async () => {
      const requiredOutput = manifest.outputs.some((output) => output.required);
      if (!requiredOutput) return;
      const dir = tempDir();
      const outputDir = path.join(dir, "output");
      fs.mkdirSync(outputDir, { recursive: true });
      await expect(
        adapter!.collectOutputs({
          manifestName: name,
          inputPath: path.join(dir, "input"),
          outputDir,
          modelDir: path.join(dir, "model"),
          assetsDir: path.join(dir, "model", "assets"),
          params: {},
          runtimeExecutable: "python",
        }),
      ).rejects.toMatchObject({ code: "MISSING_REQUIRED_OUTPUT" });
    });

    it("reports a nonexistent model directory as not installed", async () => {
      const dir = tempDir();
      const result = await adapter!.verifyInstallation({
        manifestName: name,
        modelDir: path.join(dir, "no-such-model"),
        assetsDir: path.join(dir, "no-such-model", "assets"),
      });
      expect(result.passed).toBe(false);
    });
  },
);
