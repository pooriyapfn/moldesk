import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { diffdockAdapter } from "./index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-diffdock-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PDB_TEXT = "HEADER    TEST\nATOM      1  N   MET A   1      11.104  13.207   2.070  1.00 20.00           N\nEND\n";
const SDF_TEXT = "ligand\n  MoleculeDesk\n\n  1  0  0  0  0  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\nM  END\n$$$$\n";

function writeJob(
  dir: string,
  overrides: Record<string, unknown> = {},
  options: { withLigandFile?: boolean; withSmiles?: boolean; withProteinFile?: boolean } = {},
): string {
  if (options.withProteinFile !== false) fs.writeFileSync(path.join(dir, "protein.pdb"), PDB_TEXT);
  const ligand: Record<string, unknown> = {};
  if (options.withSmiles) {
    ligand["smiles"] = "CCO";
  } else if (options.withLigandFile !== false) {
    fs.writeFileSync(path.join(dir, "ligand.sdf"), SDF_TEXT);
    ligand["path"] = "ligand.sdf";
  }
  const job = { proteinPath: "protein.pdb", ligand, ...overrides };
  const jobPath = path.join(dir, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify(job));
  return jobPath;
}

describe("diffdockAdapter.validateInput", () => {
  it("accepts a job referencing a ligand file", async () => {
    const dir = tempDir();
    const jobPath = writeJob(dir);
    await expect(diffdockAdapter.validateInput(jobPath)).resolves.toBeUndefined();
  });

  it("accepts a job referencing a ligand SMILES string", async () => {
    const dir = tempDir();
    const jobPath = writeJob(dir, {}, { withSmiles: true });
    await expect(diffdockAdapter.validateInput(jobPath)).resolves.toBeUndefined();
  });

  it("rejects a missing job file", async () => {
    const dir = tempDir();
    await expect(diffdockAdapter.validateInput(path.join(dir, "missing.json"))).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a non-.json extension", async () => {
    const dir = tempDir();
    const jobPath = path.join(dir, "job.yaml");
    fs.writeFileSync(jobPath, "{}");
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects malformed JSON", async () => {
    const dir = tempDir();
    const jobPath = path.join(dir, "job.json");
    fs.writeFileSync(jobPath, "{ not json");
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a ligand specifying both path and smiles", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "ligand.sdf"), SDF_TEXT);
    const jobPath = writeJob(dir, { ligand: { path: "ligand.sdf", smiles: "CCO" } });
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a ligand specifying neither path nor smiles", async () => {
    const dir = tempDir();
    const jobPath = writeJob(dir, { ligand: {} });
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a protein reference with the wrong extension", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "protein.txt"), PDB_TEXT);
    const jobPath = writeJob(dir, { proteinPath: "protein.txt" });
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a ligand file reference with an unsupported extension", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "ligand.xyz"), SDF_TEXT);
    const jobPath = writeJob(dir, { ligand: { path: "ligand.xyz" } });
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a protein reference that is a directory", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "protein.pdb"));
    const jobPath = writeJob(dir, { proteinPath: "protein.pdb" }, { withProteinFile: false, withSmiles: true });
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a protein file that does not look like a PDB", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "protein.pdb"), "not a pdb file\njust text\n");
    const jobPath = writeJob(dir, {}, { withProteinFile: false, withSmiles: true });
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects an invalid SMILES string", async () => {
    const dir = tempDir();
    const jobPath = writeJob(dir, { ligand: { smiles: "not smiles!! spaces" } });
    await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  describe("jobName sanitization", () => {
    it("accepts a plain identifier", async () => {
      const dir = tempDir();
      const jobPath = writeJob(dir, { jobName: "complex-A.1" });
      await expect(diffdockAdapter.validateInput(jobPath)).resolves.toBeUndefined();
    });

    it("rejects an empty jobName", async () => {
      const dir = tempDir();
      const jobPath = writeJob(dir, { jobName: "" });
      await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
    });

    it("rejects a jobName containing a path separator", async () => {
      const dir = tempDir();
      const jobPath = writeJob(dir, { jobName: "a/b" });
      await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
    });

    it("rejects a jobName containing ..", async () => {
      const dir = tempDir();
      const jobPath = writeJob(dir, { jobName: "..secret" });
      await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
    });

    it("rejects a jobName containing a control character", async () => {
      const dir = tempDir();
      const jobPath = writeJob(dir, { jobName: "a\nb" });
      await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
    });

    it("rejects an overlong jobName", async () => {
      const dir = tempDir();
      const jobPath = writeJob(dir, { jobName: "a".repeat(200) });
      await expect(diffdockAdapter.validateInput(jobPath)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
    });
  });
});

describe("diffdockAdapter against the checked-in example", () => {
  it("validates examples/diffdock/job.json", async () => {
    const exampleJob = fileURLToPath(new URL("../../../../examples/diffdock/job.json", import.meta.url));
    await expect(diffdockAdapter.validateInput(exampleJob)).resolves.toBeUndefined();
  });
});

describe("diffdockAdapter.resolveCompanionInputs", () => {
  it("returns protein + ligand refs for a ligand-file job", async () => {
    const dir = tempDir();
    const jobPath = writeJob(dir);
    const refs = await diffdockAdapter.resolveCompanionInputs!(jobPath);
    expect(refs).toEqual([
      { id: "protein", sourcePath: "protein.pdb" },
      { id: "ligand", sourcePath: "ligand.sdf" },
    ]);
  });

  it("returns only a protein ref for a SMILES-ligand job", async () => {
    const dir = tempDir();
    const jobPath = writeJob(dir, {}, { withSmiles: true });
    const refs = await diffdockAdapter.resolveCompanionInputs!(jobPath);
    expect(refs).toEqual([{ id: "protein", sourcePath: "protein.pdb" }]);
  });
});

const UPSTREAM_CONFIG_YAML = `
actual_steps: 19
ckpt: best_ema_inference_epoch_model.pt
confidence_ckpt: best_model_epoch75.pt
confidence_model_dir: ./workdir/v1.1/confidence_model
model_dir: ./workdir/v1.1/score_model
samples_per_complex: 10
inference_steps: 20
sigma_schedule: expbeta
temp_sampling_tr: 1.170050527854316
old_filtering_model: true
`;

function writeInstalledSourceFixture(modelDir: string): void {
  const sourceDir = path.join(modelDir, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "inference.py"), "# fixture\n");
  fs.writeFileSync(path.join(sourceDir, "default_inference_args.yaml"), UPSTREAM_CONFIG_YAML);
}

describe("diffdockAdapter.command", () => {
  it("builds the expected inference.py invocation and derives a run-scoped config", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    writeInstalledSourceFixture(modelDir);
    const outputDir = path.join(dir, "run", "output");
    fs.mkdirSync(outputDir, { recursive: true });
    const jobPath = path.join(dir, "run", "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ jobName: "my-complex", proteinPath: "protein.pdb", ligand: { path: "ligand.sdf" } }));

    const spec = await diffdockAdapter.command({
      manifestName: "diffdock",
      inputPath: jobPath,
      outputDir,
      modelDir,
      assetsDir: path.join(modelDir, "assets"),
      params: { samples_per_complex: 8, inference_steps: 15, batch_size: 4 },
      runtimeExecutable: path.join(modelDir, ".venv", "bin", "python"),
      platform: "linux-x64",
      companionInputs: [
        { id: "protein", path: "/run/input/protein/protein.pdb" },
        { id: "ligand", path: "/run/input/ligand/ligand.sdf" },
      ],
    });

    expect(spec.executable).toBe(path.join(modelDir, ".venv", "bin", "python"));
    expect(spec.args[0]).toBe(path.join(modelDir, "source", "inference.py"));
    expect(spec.args).toContain("--protein_path");
    expect(spec.args).toContain("/run/input/protein/protein.pdb");
    expect(spec.args).toContain("--ligand_description");
    expect(spec.args).toContain("/run/input/ligand/ligand.sdf");
    expect(spec.args).toContain("--complex_name");
    expect(spec.args).toContain("my-complex");
    expect(spec.args).toContain("--out_dir");
    expect(spec.args).toContain(outputDir);
    expect(spec.args).toContain("--model_dir");
    expect(spec.args).toContain(path.join(modelDir, "assets", "diffdock-weights", "score_model"));
    expect(spec.args).toContain("--confidence_model_dir");
    expect(spec.args).toContain(path.join(modelDir, "assets", "diffdock-weights", "confidence_model"));
    expect(spec.args).toContain("--samples_per_complex");
    expect(spec.args).toContain("8");
    expect(spec.args).toContain("--inference_steps");
    expect(spec.args).toContain("15");
    expect(spec.args).toContain("--batch_size");
    expect(spec.args).toContain("4");
    expect(spec.env).toEqual({ TORCH_HOME: path.join(modelDir, "assets", "torch-home") });

    const configIndex = spec.args.indexOf("--config") + 1;
    const configPath = spec.args[configIndex]!;
    expect(configPath).toBe(path.join(outputDir, "moldesk-inference-config.yaml"));
    const derived = parseYaml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    // Stripped so MoleculeDesk's own CLI flags (not silently clobbered by the
    // config-merge loop in inference.py's main()) take effect.
    expect(derived["model_dir"]).toBeUndefined();
    expect(derived["confidence_model_dir"]).toBeUndefined();
    expect(derived["samples_per_complex"]).toBeUndefined();
    expect(derived["inference_steps"]).toBeUndefined();
    expect(derived["actual_steps"]).toBeUndefined();
    // Every other tuned hyperparameter is preserved byte-for-byte.
    expect(derived["ckpt"]).toBe("best_ema_inference_epoch_model.pt");
    expect(derived["confidence_ckpt"]).toBe("best_model_epoch75.pt");
    expect(derived["sigma_schedule"]).toBe("expbeta");
    expect(derived["temp_sampling_tr"]).toBe(1.170050527854316);
    expect(derived["old_filtering_model"]).toBe(true);
  });

  it("uses the job's ligand SMILES directly when no ligand file companion is staged", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    writeInstalledSourceFixture(modelDir);
    const outputDir = path.join(dir, "run", "output");
    fs.mkdirSync(outputDir, { recursive: true });
    const jobPath = path.join(dir, "run", "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ proteinPath: "protein.pdb", ligand: { smiles: "CCO" } }));

    const spec = await diffdockAdapter.command({
      manifestName: "diffdock",
      inputPath: jobPath,
      outputDir,
      modelDir,
      assetsDir: path.join(modelDir, "assets"),
      params: {},
      runtimeExecutable: path.join(modelDir, ".venv", "bin", "python"),
      companionInputs: [{ id: "protein", path: "/run/input/protein/protein.pdb" }],
    });
    expect(spec.args).toContain("--ligand_description");
    expect(spec.args).toContain("CCO");
    expect(spec.args).toContain("--complex_name");
    expect(spec.args).toContain("complex_0");
  });

  it("throws a clear internal error when a declared companion input was not staged", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    writeInstalledSourceFixture(modelDir);
    const outputDir = path.join(dir, "run", "output");
    fs.mkdirSync(outputDir, { recursive: true });
    const jobPath = path.join(dir, "run", "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ proteinPath: "protein.pdb", ligand: { path: "ligand.sdf" } }));

    await expect(
      diffdockAdapter.command({
        manifestName: "diffdock",
        inputPath: jobPath,
        outputDir,
        modelDir,
        assetsDir: path.join(modelDir, "assets"),
        params: {},
        runtimeExecutable: path.join(modelDir, ".venv", "bin", "python"),
        companionInputs: [],
      }),
    ).rejects.toMatchObject({ code: "COMPANION_INPUT_NOT_STAGED" });
  });
});

describe("diffdockAdapter.collectOutputs", () => {
  function writePrediction(outputDir: string, complexName: string): void {
    const complexDir = path.join(outputDir, complexName);
    fs.mkdirSync(complexDir, { recursive: true });
    fs.writeFileSync(path.join(complexDir, "rank1.sdf"), SDF_TEXT);
    fs.writeFileSync(path.join(complexDir, "rank1_confidence0.85.sdf"), SDF_TEXT);
    fs.writeFileSync(path.join(complexDir, "rank2_confidence-1.23.sdf"), SDF_TEXT);
  }

  it("throws INVALID_RUN_OUTPUT when a ranked-pose SDF is empty (a correctly-named file is not sufficient)", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    const complexDir = path.join(outputDir, "complex_0");
    fs.mkdirSync(complexDir, { recursive: true });
    fs.writeFileSync(path.join(complexDir, "rank1.sdf"), SDF_TEXT);
    fs.writeFileSync(path.join(complexDir, "rank1_confidence0.85.sdf"), ""); // empty file
    const jobPath = path.join(dir, "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ proteinPath: "protein.pdb", ligand: { smiles: "CCO" } }));

    await expect(
      diffdockAdapter.collectOutputs({
        manifestName: "diffdock",
        inputPath: jobPath,
        outputDir,
        modelDir: dir,
        assetsDir: path.join(dir, "assets"),
        params: {},
        runtimeExecutable: "python",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RUN_OUTPUT" });
  });

  it("throws INVALID_RUN_OUTPUT when a ranked-pose SDF has no positive atom count", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    const complexDir = path.join(outputDir, "complex_0");
    fs.mkdirSync(complexDir, { recursive: true });
    fs.writeFileSync(path.join(complexDir, "rank1.sdf"), SDF_TEXT);
    // Malformed: counts line present but zero atoms.
    fs.writeFileSync(path.join(complexDir, "rank1_confidence0.85.sdf"), "ligand\n  MoleculeDesk\n\n  0  0  0  0  0  0  0  0  0  0999 V2000\nM  END\n$$$$\n");
    const jobPath = path.join(dir, "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ proteinPath: "protein.pdb", ligand: { smiles: "CCO" } }));

    await expect(
      diffdockAdapter.collectOutputs({
        manifestName: "diffdock",
        inputPath: jobPath,
        outputDir,
        modelDir: dir,
        assetsDir: path.join(dir, "assets"),
        params: {},
        runtimeExecutable: "python",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RUN_OUTPUT" });
  });

  it("throws INVALID_RUN_OUTPUT when the top pose (rank1.sdf) itself is empty", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    const complexDir = path.join(outputDir, "complex_0");
    fs.mkdirSync(complexDir, { recursive: true });
    fs.writeFileSync(path.join(complexDir, "rank1.sdf"), ""); // empty top pose
    fs.writeFileSync(path.join(complexDir, "rank1_confidence0.85.sdf"), SDF_TEXT);
    const jobPath = path.join(dir, "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ proteinPath: "protein.pdb", ligand: { smiles: "CCO" } }));

    await expect(
      diffdockAdapter.collectOutputs({
        manifestName: "diffdock",
        inputPath: jobPath,
        outputDir,
        modelDir: dir,
        assetsDir: path.join(dir, "assets"),
        params: {},
        runtimeExecutable: "python",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RUN_OUTPUT" });
  });

  it("collects ranked poses and synthesizes a structured poses_summary.json", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    writePrediction(outputDir, "complex_0");
    const jobPath = path.join(dir, "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ proteinPath: "protein.pdb", ligand: { smiles: "CCO" } }));

    const outputs = await diffdockAdapter.collectOutputs({
      manifestName: "diffdock",
      inputPath: jobPath,
      outputDir,
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
      params: {},
      runtimeExecutable: "python",
    });
    expect(outputs.map((o) => o.id).sort()).toEqual(["poses_summary", "ranked_poses", "ranked_poses", "top_pose"]);

    const summary = JSON.parse(fs.readFileSync(path.join(outputDir, "poses_summary.json"), "utf8"));
    expect(summary.complexName).toBe("complex_0");
    expect(summary.topPoseFile).toBe("rank1.sdf");
    expect(summary.poses).toHaveLength(2);
    expect(summary.poses[0]).toMatchObject({ rank: 1, confidence: 0.85, sdfFile: "rank1_confidence0.85.sdf", atomCount: 1 });
    expect(summary.poses[1]).toMatchObject({ rank: 2, confidence: -1.23, sdfFile: "rank2_confidence-1.23.sdf", atomCount: 1 });
  });

  it("respects a custom jobName as the complex directory", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    writePrediction(outputDir, "my-complex");
    const jobPath = path.join(dir, "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ jobName: "my-complex", proteinPath: "protein.pdb", ligand: { smiles: "CCO" } }));

    const outputs = await diffdockAdapter.collectOutputs({
      manifestName: "diffdock",
      inputPath: jobPath,
      outputDir,
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
      params: {},
      runtimeExecutable: "python",
    });
    expect(outputs.map((o) => o.id).sort()).toEqual(["poses_summary", "ranked_poses", "ranked_poses", "top_pose"]);
  });

  it("does not let the freshly-written poses_summary.json collide with the top_pose/ranked_poses `*/...` glob", async () => {
    // Regression test: top_pose/ranked_poses use a single-segment `*` wildcard
    // that matches ANY entry directly under outputDir, including a file (not
    // just directories) — writing poses_summary.json before collecting those
    // globs would make matchGlob try to readdir it as if it were a directory.
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    writePrediction(outputDir, "complex_0");
    const jobPath = path.join(dir, "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ proteinPath: "protein.pdb", ligand: { smiles: "CCO" } }));

    const outputs = await diffdockAdapter.collectOutputs({
      manifestName: "diffdock",
      inputPath: jobPath,
      outputDir,
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
      params: {},
      runtimeExecutable: "python",
    });
    expect(outputs.map((o) => o.id).sort()).toEqual(["poses_summary", "ranked_poses", "ranked_poses", "top_pose"]);
  });

  it("throws MISSING_REQUIRED_OUTPUT when no ranked poses were produced (a stray unrelated file must not satisfy it)", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "some-unrelated-file.txt"), "not a pose");
    const jobPath = path.join(dir, "input", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({ proteinPath: "protein.pdb", ligand: { smiles: "CCO" } }));

    await expect(
      diffdockAdapter.collectOutputs({
        manifestName: "diffdock",
        inputPath: jobPath,
        outputDir,
        modelDir: dir,
        assetsDir: path.join(dir, "assets"),
        params: {},
        runtimeExecutable: "python",
      }),
    ).rejects.toMatchObject({ code: "MISSING_REQUIRED_OUTPUT" });
  });
});

describe("diffdockAdapter.verifyInstallation", () => {
  function createInstalledFixture(modelDir: string, assetsDir: string): void {
    fs.mkdirSync(path.join(modelDir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(modelDir, ".venv", "bin", "python"), "#!/bin/sh\n");
    writeInstalledSourceFixture(modelDir);
    const scoreDir = path.join(assetsDir, "diffdock-weights", "score_model");
    const confidenceDir = path.join(assetsDir, "diffdock-weights", "confidence_model");
    fs.mkdirSync(scoreDir, { recursive: true });
    fs.mkdirSync(confidenceDir, { recursive: true });
    fs.writeFileSync(path.join(scoreDir, "model_parameters.yml"), "{}");
    fs.writeFileSync(path.join(scoreDir, "best_ema_inference_epoch_model.pt"), "");
    fs.writeFileSync(path.join(confidenceDir, "model_parameters.yml"), "{}");
    fs.writeFileSync(path.join(confidenceDir, "best_model_epoch75.pt"), "");
    const esmDir = path.join(assetsDir, "torch-home", "hub", "checkpoints");
    fs.mkdirSync(esmDir, { recursive: true });
    fs.writeFileSync(path.join(esmDir, "esm2_t33_650M_UR50D.pt"), "");
    fs.writeFileSync(path.join(esmDir, "esm2_t33_650M_UR50D-contact-regression.pt"), "");
  }

  it("fails when installed weights are missing, even with a working venv", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    fs.mkdirSync(path.join(modelDir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(modelDir, ".venv", "bin", "python"), "#!/bin/sh\n");
    writeInstalledSourceFixture(modelDir);

    const result = await diffdockAdapter.verifyInstallation({
      manifestName: "diffdock",
      modelDir,
      assetsDir: path.join(modelDir, "assets"),
      runner: async () => ({ code: 0, stdout: "should not run", stderr: "" }),
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("model_parameters.yml");
  });

  it("fails when the ABI/CUDA probe reports an error", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    const assetsDir = path.join(modelDir, "assets");
    createInstalledFixture(modelDir, assetsDir);

    const result = await diffdockAdapter.verifyInstallation({
      manifestName: "diffdock",
      modelDir,
      assetsDir,
      runner: async () => ({ code: 1, stdout: "", stderr: "torch.cuda.is_available() is False" }),
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("torch.cuda.is_available()");
  });

  it("passes and captures the ABI/CUDA probe script when weights, CUDA probe, and --help all succeed", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    const assetsDir = path.join(modelDir, "assets");
    createInstalledFixture(modelDir, assetsDir);

    let capturedScript = "";
    const result = await diffdockAdapter.verifyInstallation({
      manifestName: "diffdock",
      modelDir,
      assetsDir,
      runner: async (_cmd, args) => {
        if (args.includes("--help")) return { code: 0, stdout: "usage: inference.py [-h] ... --protein_path PROTEIN_PATH ...", stderr: "" };
        if ((args[1] ?? "").includes("torch.cuda")) capturedScript = args[1] ?? "";
        return { code: 0, stdout: "cuda ok", stderr: "" };
      },
    });
    expect(result.passed).toBe(true);
    expect(capturedScript).toContain("torch.cuda.is_available()");
    // Executes real operators, not just imports — see ABI_AND_CUDA_PROBE's doc comment.
    expect(capturedScript).toContain("torch_scatter.scatter_add");
    expect(capturedScript).toContain("torch_cluster.radius_graph");
    expect(capturedScript).toContain("torch_sparse.coalesce");
  });

  it("builds the SO(3) cache once, in a stable directory, before running --help", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    const assetsDir = path.join(modelDir, "assets");
    createInstalledFixture(modelDir, assetsDir);

    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const result = await diffdockAdapter.verifyInstallation({
      manifestName: "diffdock",
      modelDir,
      assetsDir,
      runner: async (_cmd, args, options) => {
        calls.push({ args, cwd: options?.cwd });
        if (args.includes("--help")) return { code: 0, stdout: "--protein_path", stderr: "" };
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(result.passed).toBe(true);
    const warmIdx = calls.findIndex((c) => (c.args[1] ?? "").includes("import utils.so3"));
    const helpIdx = calls.findIndex((c) => c.args.includes("--help"));
    expect(warmIdx).toBeGreaterThan(-1);
    expect(warmIdx).toBeLessThan(helpIdx);
    expect(calls[warmIdx]?.cwd).toBe(path.join(assetsDir, "so3-cache"));
    expect(calls[helpIdx]?.cwd).toBe(path.join(assetsDir, "so3-cache"));
  });

  it("fails when the SO(3) cache build fails", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    const assetsDir = path.join(modelDir, "assets");
    createInstalledFixture(modelDir, assetsDir);

    const result = await diffdockAdapter.verifyInstallation({
      manifestName: "diffdock",
      modelDir,
      assetsDir,
      runner: async (_cmd, args) =>
        (args[1] ?? "").includes("import utils.so3") ? { code: 1, stdout: "", stderr: "memory error" } : { code: 0, stdout: "ok", stderr: "" },
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("SO(3) cache");
  });

  it("fails when the installed CLI does not respond as expected to --help", async () => {
    const dir = tempDir();
    const modelDir = path.join(dir, "model");
    const assetsDir = path.join(modelDir, "assets");
    createInstalledFixture(modelDir, assetsDir);

    const result = await diffdockAdapter.verifyInstallation({
      manifestName: "diffdock",
      modelDir,
      assetsDir,
      runner: async (_cmd, args) => {
        if (args.includes("--help")) return { code: 1, stdout: "", stderr: "boom" };
        return { code: 0, stdout: "cuda ok", stderr: "" };
      },
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("--help");
  });
});
