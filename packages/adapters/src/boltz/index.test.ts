import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boltzAdapter } from "./index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-boltz-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("boltzAdapter.validateInput", () => {
  it.each([".fa", ".fas", ".fasta", ".yml", ".yaml"])("accepts a %s input file", async (extension) => {
    const dir = tempDir();
    const input = path.join(dir, `structure${extension}`);
    fs.writeFileSync(input, "content");
    await expect(boltzAdapter.validateInput(input)).resolves.toBeUndefined();
  });

  it("rejects a missing file", async () => {
    await expect(boltzAdapter.validateInput(path.join(tempDir(), "missing.yaml"))).rejects.toMatchObject({
      code: "INVALID_RUN_INPUT",
    });
  });

  it("rejects an unaccepted extension", async () => {
    const dir = tempDir();
    const input = path.join(dir, "structure.pdb");
    fs.writeFileSync(input, "content");
    await expect(boltzAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });
});

describe("boltzAdapter.command", () => {
  it("hardcodes --output_format mmcif and never exposes use_msa_server", async () => {
    const spec = await boltzAdapter.command({
      manifestName: "boltz",
      inputPath: "/run/input/structure.yaml",
      outputDir: "/run/output",
      modelDir: "/models/boltz",
      assetsDir: "/models/boltz/assets",
      params: { accelerator: "gpu" },
      runtimeExecutable: "/models/boltz/.venv/bin/python",
    });
    expect(spec.executable).toBe(path.join("/models/boltz", ".venv", "bin", "boltz"));
    expect(spec.args).toContain("--output_format");
    expect(spec.args[spec.args.indexOf("--output_format") + 1]).toBe("mmcif");
    expect(spec.args).not.toContain("--use_msa_server");
    expect(spec.args).not.toContain("--model");
    expect(spec.args).toContain("--cache");
    expect(spec.args).toContain("/models/boltz/assets");
    expect(spec.args).toContain("--accelerator");
    expect(spec.args[spec.args.indexOf("--accelerator") + 1]).toBe("gpu");
  });

  it("defaults to gpu when accelerator is not a string", async () => {
    const spec = await boltzAdapter.command({
      manifestName: "boltz",
      inputPath: "/run/input/structure.yaml",
      outputDir: "/run/output",
      modelDir: "/models/boltz",
      assetsDir: "/models/boltz/assets",
      params: {},
      runtimeExecutable: "/models/boltz/.venv/bin/python",
    });
    expect(spec.args[spec.args.indexOf("--accelerator") + 1]).toBe("gpu");
  });

  it("maps optional params to their real CLI flags", async () => {
    const spec = await boltzAdapter.command({
      manifestName: "boltz",
      inputPath: "/run/input/structure.yaml",
      outputDir: "/run/output",
      modelDir: "/models/boltz",
      assetsDir: "/models/boltz/assets",
      params: { accelerator: "cpu", recycling_steps: 5, sampling_steps: 100, diffusion_samples: 2, seed: 42, override: true },
      runtimeExecutable: "/models/boltz/.venv/bin/python",
    });
    expect(spec.args).toEqual(
      expect.arrayContaining([
        "--recycling_steps", "5",
        "--sampling_steps", "100",
        "--diffusion_samples", "2",
        "--seed", "42",
        "--override",
      ]),
    );
  });
});

describe("boltzAdapter.collectOutputs", () => {
  it("collects .cif files from the real three-level-deep boltz output layout", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    const nested = path.join(outputDir, "boltz_results_structure", "predictions", "structure");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "structure.cif"), "data_structure");

    const outputs = await boltzAdapter.collectOutputs({
      manifestName: "boltz",
      inputPath: path.join(dir, "input", "structure.yaml"),
      outputDir,
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
      params: {},
      runtimeExecutable: "python",
    });
    expect(outputs).toEqual([{ id: "structures", path: path.join(nested, "structure.cif") }]);
  });

  it("throws MISSING_REQUIRED_OUTPUT when no .cif files were produced", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    fs.mkdirSync(outputDir, { recursive: true });

    await expect(
      boltzAdapter.collectOutputs({
        manifestName: "boltz",
        inputPath: path.join(dir, "input", "structure.yaml"),
        outputDir,
        modelDir: dir,
        assetsDir: path.join(dir, "assets"),
        params: {},
        runtimeExecutable: "python",
      }),
    ).rejects.toMatchObject({ code: "MISSING_REQUIRED_OUTPUT" });
  });
});

describe("boltzAdapter.verifyInstallation", () => {
  it("reports missing assets", async () => {
    const dir = tempDir();
    const result = await boltzAdapter.verifyInstallation({
      manifestName: "boltz",
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("boltz2_conf.ckpt");
  });
});
