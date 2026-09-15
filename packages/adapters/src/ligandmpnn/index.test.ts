import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ligandmpnnAdapter } from "./index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-ligandmpnn-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ligandmpnnAdapter.validateInput", () => {
  it("accepts an existing .pdb file", async () => {
    const dir = tempDir();
    const input = path.join(dir, "structure.pdb");
    fs.writeFileSync(input, "ATOM\n");
    await expect(ligandmpnnAdapter.validateInput(input)).resolves.toBeUndefined();
  });

  it("rejects a missing file", async () => {
    await expect(ligandmpnnAdapter.validateInput(path.join(tempDir(), "missing.pdb"))).rejects.toMatchObject({
      code: "INVALID_RUN_INPUT",
    });
  });

  it("rejects a non-.pdb extension", async () => {
    const dir = tempDir();
    const input = path.join(dir, "structure.cif");
    fs.writeFileSync(input, "ATOM\n");
    await expect(ligandmpnnAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });
});

describe("ligandmpnnAdapter.command", () => {
  it("always sets --model_type ligand_mpnn and an absolute checkpoint path", async () => {
    const spec = await ligandmpnnAdapter.command({
      manifestName: "ligandmpnn",
      inputPath: "/run/input/structure.pdb",
      outputDir: "/run/output",
      modelDir: "/models/ligandmpnn",
      assetsDir: "/models/ligandmpnn/assets",
      params: { temperature: 0.1, seed: 0, batch_size: 1, number_of_batches: 1 },
      runtimeExecutable: "/models/ligandmpnn/.venv/bin/python",
    });
    expect(spec.args).toContain("--model_type");
    expect(spec.args).toContain("ligand_mpnn");
    expect(spec.args).toContain("--checkpoint_ligand_mpnn");
    expect(spec.args).toContain(path.join("/models/ligandmpnn/assets", "model_params", "ligandmpnn_v_32_010_25.pt"));
    expect(spec.args).toContain("--temperature");
    expect(spec.args).toContain("0.1");
  });
});

describe("ligandmpnnAdapter.collectOutputs", () => {
  it("collects generated .fa files from the seqs/ subdirectory", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    fs.mkdirSync(path.join(outputDir, "seqs"), { recursive: true });
    fs.writeFileSync(path.join(outputDir, "seqs", "structure.fa"), ">structure\nMKV\n");

    const outputs = await ligandmpnnAdapter.collectOutputs({
      manifestName: "ligandmpnn",
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
      ligandmpnnAdapter.collectOutputs({
        manifestName: "ligandmpnn",
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
