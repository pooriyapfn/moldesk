import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { proteinmpnnAdapter } from "./index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-proteinmpnn-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("proteinmpnnAdapter.validateInput", () => {
  it("accepts an existing .pdb file", async () => {
    const dir = tempDir();
    const input = path.join(dir, "structure.pdb");
    fs.writeFileSync(input, "ATOM\n");
    await expect(proteinmpnnAdapter.validateInput(input)).resolves.toBeUndefined();
  });

  it("rejects a missing file", async () => {
    await expect(proteinmpnnAdapter.validateInput(path.join(tempDir(), "missing.pdb"))).rejects.toMatchObject({
      code: "INVALID_RUN_INPUT",
    });
  });

  it("rejects a non-.pdb extension", async () => {
    const dir = tempDir();
    const input = path.join(dir, "structure.txt");
    fs.writeFileSync(input, "ATOM\n");
    await expect(proteinmpnnAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });
});

describe("proteinmpnnAdapter.command", () => {
  it("builds the expected executable/args shape", async () => {
    const spec = await proteinmpnnAdapter.command({
      manifestName: "proteinmpnn",
      inputPath: "/run/input/structure.pdb",
      outputDir: "/run/output",
      modelDir: "/models/proteinmpnn",
      assetsDir: "/models/proteinmpnn/assets",
      params: { num_seq_per_target: 2, sampling_temp: "0.1", seed: 0, batch_size: 1, ca_only: true },
      runtimeExecutable: "/models/proteinmpnn/.venv/bin/python",
    });
    expect(spec.executable).toBe("/models/proteinmpnn/.venv/bin/python");
    expect(spec.args).toContain("--pdb_path");
    expect(spec.args).toContain("/run/input/structure.pdb");
    expect(spec.args).toContain("--out_folder");
    expect(spec.args).toContain("/run/output");
    expect(spec.args).toContain("--path_to_model_weights");
    expect(spec.args).toContain(path.join("/models/proteinmpnn/assets", "vanilla_model_weights"));
    expect(spec.args).toContain("--num_seq_per_target");
    expect(spec.args).toContain("2");
    expect(spec.args).toContain("--ca_only");
  });

  it("omits --ca_only when false", async () => {
    const spec = await proteinmpnnAdapter.command({
      manifestName: "proteinmpnn",
      inputPath: "/run/input/structure.pdb",
      outputDir: "/run/output",
      modelDir: "/models/proteinmpnn",
      assetsDir: "/models/proteinmpnn/assets",
      params: { num_seq_per_target: 1, sampling_temp: "0.1", seed: 0, batch_size: 1, ca_only: false },
      runtimeExecutable: "/models/proteinmpnn/.venv/bin/python",
    });
    expect(spec.args).not.toContain("--ca_only");
  });
});

describe("proteinmpnnAdapter.collectOutputs", () => {
  it("collects generated .fa files from the seqs/ subdirectory", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    fs.mkdirSync(path.join(outputDir, "seqs"), { recursive: true });
    fs.writeFileSync(path.join(outputDir, "seqs", "structure.fa"), ">structure\nMKV\n");

    const outputs = await proteinmpnnAdapter.collectOutputs({
      manifestName: "proteinmpnn",
      inputPath: path.join(dir, "input", "structure.pdb"),
      outputDir,
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
      params: {},
      runtimeExecutable: "python",
    });
    expect(outputs).toEqual([{ id: "sequences", path: path.join(outputDir, "seqs", "structure.fa") }]);
  });

  it("throws MISSING_REQUIRED_OUTPUT when no .fa files were produced", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    fs.mkdirSync(outputDir, { recursive: true });

    await expect(
      proteinmpnnAdapter.collectOutputs({
        manifestName: "proteinmpnn",
        inputPath: path.join(dir, "input", "structure.pdb"),
        outputDir,
        modelDir: dir,
        assetsDir: path.join(dir, "assets"),
        params: {},
        runtimeExecutable: "python",
      }),
    ).rejects.toMatchObject({ code: "MISSING_REQUIRED_OUTPUT" });
  });
});
