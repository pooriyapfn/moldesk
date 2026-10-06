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
  it("accepts a .yaml job file with a top-level sequences key", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.yaml");
    fs.writeFileSync(input, "sequences:\n  - protein:\n      id: A\n      sequence: MKV\n");
    await expect(boltzAdapter.validateInput(input)).resolves.toBeUndefined();
  });

  it("accepts a .yml job file", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.yml");
    fs.writeFileSync(input, "sequences:\n  - protein:\n      id: A\n      sequence: MKV\n");
    await expect(boltzAdapter.validateInput(input)).resolves.toBeUndefined();
  });

  it("accepts a non-empty .fasta file without a sequences-key check", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.fasta");
    fs.writeFileSync(input, ">A\nMKV\n");
    await expect(boltzAdapter.validateInput(input)).resolves.toBeUndefined();
  });

  it("rejects a missing file", async () => {
    await expect(boltzAdapter.validateInput(path.join(tempDir(), "missing.yaml"))).rejects.toMatchObject({
      code: "INVALID_RUN_INPUT",
    });
  });

  it("rejects an unsupported extension", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.pdb");
    fs.writeFileSync(input, "ATOM\n");
    await expect(boltzAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects an empty .yaml file", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.yaml");
    fs.writeFileSync(input, "");
    await expect(boltzAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a .yaml file missing a top-level sequences key", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.yaml");
    fs.writeFileSync(input, "version: 1\nname: not-a-job\n");
    await expect(boltzAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects an empty .fasta file", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.fasta");
    fs.writeFileSync(input, "   \n");
    await expect(boltzAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects syntactically malformed YAML that a regex-based check would miss", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.yaml");
    // An unclosed flow sequence — `/^sequences\s*:/m` would match this and let
    // it through; a real YAML parser must reject it.
    fs.writeFileSync(input, "sequences: [\n");
    await expect(boltzAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a .yaml file where sequences is not an array", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.yaml");
    fs.writeFileSync(input, "sequences: not-a-list\n");
    await expect(boltzAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });

  it("rejects a .yaml file where sequences is an empty array", async () => {
    const dir = tempDir();
    const input = path.join(dir, "job.yaml");
    fs.writeFileSync(input, "sequences: []\n");
    await expect(boltzAdapter.validateInput(input)).rejects.toMatchObject({ code: "INVALID_RUN_INPUT" });
  });
});

describe("boltzAdapter.resolveParamDefaults", () => {
  it("resolves accelerator:mps for a darwin-arm64 install", () => {
    const defaults = boltzAdapter.resolveParamDefaults!({
      manifestName: "boltz",
      installed: { runtime: { kind: "python", python: { platform: "darwin-arm64", platformSelected: true } } },
    });
    expect(defaults).toEqual({ accelerator: "mps" });
  });

  it("resolves accelerator:gpu for a linux-x64 install", () => {
    const defaults = boltzAdapter.resolveParamDefaults!({
      manifestName: "boltz",
      installed: { runtime: { kind: "python", python: { platform: "linux-x64", platformSelected: true } } },
    });
    expect(defaults).toEqual({ accelerator: "gpu" });
  });
});

describe("boltzAdapter.command", () => {
  it("builds the expected boltz predict invocation", async () => {
    const spec = await boltzAdapter.command({
      manifestName: "boltz",
      inputPath: "/run/input/job.yaml",
      outputDir: "/run/output",
      modelDir: "/models/boltz",
      assetsDir: "/models/boltz/assets",
      params: {
        accelerator: "gpu",
        devices: 1,
        recycling_steps: 3,
        sampling_steps: 200,
        diffusion_samples: 1,
        max_parallel_samples: 5,
        use_msa_server: true,
        no_kernels: false,
        seed: 42,
      },
      runtimeExecutable: "/models/boltz/.venv/bin/python",
      platform: "linux-x64",
    });
    expect(spec.executable).toBe(path.join("/models/boltz/.venv/bin", "boltz"));
    expect(spec.args[0]).toBe("predict");
    expect(spec.args[1]).toBe("/run/input/job.yaml");
    expect(spec.args).toContain("--out_dir");
    expect(spec.args).toContain("/run/output");
    expect(spec.args).toContain("--cache");
    expect(spec.args).toContain(path.join("/models/boltz/assets", "boltz-cache"));
    expect(spec.args).toContain("--accelerator");
    expect(spec.args).toContain("gpu");
    expect(spec.args).toContain("--devices");
    expect(spec.args).toContain("--recycling_steps");
    expect(spec.args).toContain("--sampling_steps");
    expect(spec.args).toContain("--diffusion_samples");
    expect(spec.args).toContain("--max_parallel_samples");
    expect(spec.args).toContain("--use_msa_server");
    expect(spec.args).not.toContain("--no_kernels");
    expect(spec.args).toContain("--seed");
    expect(spec.args).toContain("42");
  });

  it("omits boolean flags when false", async () => {
    const spec = await boltzAdapter.command({
      manifestName: "boltz",
      inputPath: "/run/input/job.yaml",
      outputDir: "/run/output",
      modelDir: "/models/boltz",
      assetsDir: "/models/boltz/assets",
      params: { accelerator: "mps", use_msa_server: false, no_kernels: false },
      runtimeExecutable: "/models/boltz/.venv/bin/python",
      platform: "darwin-arm64",
    });
    expect(spec.args).not.toContain("--use_msa_server");
    expect(spec.args).not.toContain("--no_kernels");
  });

  it("rejects accelerator=mps on a non-darwin-arm64 installation", async () => {
    await expect(
      boltzAdapter.command({
        manifestName: "boltz",
        inputPath: "/run/input/job.yaml",
        outputDir: "/run/output",
        modelDir: "/models/boltz",
        assetsDir: "/models/boltz/assets",
        params: { accelerator: "mps" },
        runtimeExecutable: "/models/boltz/.venv/bin/python",
        platform: "linux-x64",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RUN_PARAMS" });
  });

  it("rejects accelerator=gpu on a darwin-arm64 installation", async () => {
    await expect(
      boltzAdapter.command({
        manifestName: "boltz",
        inputPath: "/run/input/job.yaml",
        outputDir: "/run/output",
        modelDir: "/models/boltz",
        assetsDir: "/models/boltz/assets",
        params: { accelerator: "gpu" },
        runtimeExecutable: "/models/boltz/.venv/bin/python",
        platform: "darwin-arm64",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RUN_PARAMS" });
  });
});

describe("boltzAdapter.collectOutputs", () => {
  function writePrediction(outputDir: string, options: { withAffinity?: boolean } = {}): void {
    const predDir = path.join(outputDir, "boltz_results_job", "predictions", "record1");
    fs.mkdirSync(predDir, { recursive: true });
    fs.writeFileSync(path.join(predDir, "record1_model_0.cif"), "data_record1\n");
    fs.writeFileSync(path.join(predDir, "confidence_record1_model_0.json"), "{}");
    if (options.withAffinity) {
      fs.writeFileSync(path.join(predDir, "affinity_record1.json"), "{}");
    }
  }

  it("collects structures, confidence, and (when present) affinity outputs", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    writePrediction(outputDir, { withAffinity: true });

    const outputs = await boltzAdapter.collectOutputs({
      manifestName: "boltz",
      inputPath: path.join(dir, "input", "job.yaml"),
      outputDir,
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
      params: {},
      runtimeExecutable: "python",
    });
    expect(outputs.map((o) => o.id).sort()).toEqual(["affinity", "confidence", "structures"]);
  });

  it("succeeds without affinity output since it is not required", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    writePrediction(outputDir);

    const outputs = await boltzAdapter.collectOutputs({
      manifestName: "boltz",
      inputPath: path.join(dir, "input", "job.yaml"),
      outputDir,
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
      params: {},
      runtimeExecutable: "python",
    });
    expect(outputs.map((o) => o.id).sort()).toEqual(["confidence", "structures"]);
  });

  it("throws MISSING_REQUIRED_OUTPUT when no .cif files were produced", async () => {
    const dir = tempDir();
    const outputDir = path.join(dir, "output");
    fs.mkdirSync(outputDir, { recursive: true });

    await expect(
      boltzAdapter.collectOutputs({
        manifestName: "boltz",
        inputPath: path.join(dir, "input", "job.yaml"),
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
  /** Creates the venv scripts + the three install-time-populated cache assets
   * (mols/, boltz2_conf.ckpt, boltz2_aff.ckpt) verifyInstallation now requires
   * to exist before running any probe. */
  function createInstalledFixture(dir: string, assetsDir: string): void {
    fs.mkdirSync(path.join(dir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(dir, ".venv", "bin", "boltz"), "#!/bin/sh\n");
    const cacheDir = path.join(assetsDir, "boltz-cache");
    fs.mkdirSync(path.join(cacheDir, "mols"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "boltz2_conf.ckpt"), "");
    fs.writeFileSync(path.join(cacheDir, "boltz2_aff.ckpt"), "");
  }

  it("fails when the venv's boltz console script is missing", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n");

    const result = await boltzAdapter.verifyInstallation({ manifestName: "boltz", modelDir: dir, assetsDir: path.join(dir, "assets") });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("boltz");
  });

  it("fails when the install-time-populated checkpoint/CCD cache is missing, even with a working venv", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(dir, ".venv", "bin", "boltz"), "#!/bin/sh\n");
    // No boltz-cache/ populated — checkpoints/CCD must be verified present
    // before a run is ever allowed, never lazily downloaded at run time.

    const result = await boltzAdapter.verifyInstallation({
      manifestName: "boltz",
      modelDir: dir,
      assetsDir: path.join(dir, "assets"),
      runner: async () => ({ code: 0, stdout: "should not run", stderr: "" }),
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("boltz-cache");
  });

  it("runs the CUDA probe via the injected runner when no installation.json platform is recorded", async () => {
    const dir = tempDir();
    const assetsDir = path.join(dir, "assets");
    createInstalledFixture(dir, assetsDir);

    let capturedScript = "";
    const result = await boltzAdapter.verifyInstallation({
      manifestName: "boltz",
      modelDir: dir,
      assetsDir,
      runner: async (_cmd, args) => {
        capturedScript = args[1] ?? "";
        return { code: 0, stdout: "cuda ok", stderr: "" };
      },
    });
    expect(result.passed).toBe(true);
    expect(capturedScript).toContain("torch.cuda.is_available()");
    expect(capturedScript).toContain("torch.version.cuda is not None");
    expect(capturedScript).toContain('== "2.2.1"');
  });

  it("runs the MPS probe when installation.json records a darwin-arm64 platform", async () => {
    const dir = tempDir();
    const assetsDir = path.join(dir, "assets");
    createInstalledFixture(dir, assetsDir);
    fs.writeFileSync(
      path.join(dir, "installation.json"),
      JSON.stringify({ runtime: { python: { platform: "darwin-arm64" } } }),
    );

    let capturedScript = "";
    const result = await boltzAdapter.verifyInstallation({
      manifestName: "boltz",
      modelDir: dir,
      assetsDir,
      runner: async (cmd, args) => {
        if (cmd.endsWith("boltz")) return { code: 0, stdout: "--accelerator [gpu|cpu|tpu|mps]", stderr: "" };
        capturedScript = args[1] ?? "";
        return { code: 0, stdout: "mps ok", stderr: "" };
      },
    });
    expect(result.passed).toBe(true);
    expect(capturedScript).toContain("torch.backends.mps.is_available()");
    expect(capturedScript).toContain('== "2.10.12"');
    expect(capturedScript).toContain('official_version is None');
  });

  it("runs the MPS probe from context.platform even with no installation.json (pre-promotion staging verify)", async () => {
    const dir = tempDir();
    const assetsDir = path.join(dir, "assets");
    createInstalledFixture(dir, assetsDir);
    // No installation.json written yet — this is the staging-directory verify call
    // the core installer makes BEFORE promotion, so installation.json cannot exist.
    // The adapter must trust context.platform here, not fall back to CUDA.

    let capturedScript = "";
    const result = await boltzAdapter.verifyInstallation({
      manifestName: "boltz",
      modelDir: dir,
      assetsDir,
      platform: "darwin-arm64",
      runner: async (cmd, args) => {
        if (cmd.endsWith("boltz")) return { code: 0, stdout: "--accelerator [gpu|cpu|tpu|mps]", stderr: "" };
        capturedScript = args[1] ?? "";
        return { code: 0, stdout: "mps ok", stderr: "" };
      },
    });
    expect(result.passed).toBe(true);
    expect(capturedScript).toContain("torch.backends.mps.is_available()");
  });

  it("fails when the installed CLI doesn't advertise an mps accelerator choice", async () => {
    const dir = tempDir();
    const assetsDir = path.join(dir, "assets");
    createInstalledFixture(dir, assetsDir);

    const result = await boltzAdapter.verifyInstallation({
      manifestName: "boltz",
      modelDir: dir,
      assetsDir,
      platform: "darwin-arm64",
      runner: async (cmd) => {
        if (cmd.endsWith("boltz")) return { code: 0, stdout: "--accelerator [gpu|cpu|tpu]", stderr: "" };
        return { code: 0, stdout: "mps ok", stderr: "" };
      },
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("mps");
  });

  it("reports failure output when the probe fails", async () => {
    const dir = tempDir();
    const assetsDir = path.join(dir, "assets");
    createInstalledFixture(dir, assetsDir);

    const result = await boltzAdapter.verifyInstallation({
      manifestName: "boltz",
      modelDir: dir,
      assetsDir,
      runner: async () => ({ code: 1, stdout: "", stderr: "MPS backend is not available on this host" }),
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("MPS backend is not available");
  });
});
