import fs from "node:fs";
import path from "node:path";
import type { CommandSpec, OutputSpec, PlatformId } from "@moldesk/registry";
import { MoldeskError } from "@moldesk/registry";
import { runCommand } from "@moldesk/runtime";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type {
  CollectedOutput,
  InstallContext,
  InstallPlan,
  ModelAdapterDefinition,
  ParamDescriptor,
  ResolveParamDefaultsContext,
  RunContext,
  VerificationResult,
} from "../index.js";
import { collectGlobOutputs } from "../outputs.js";

/**
 * Boltz's CLI writes `<out_dir>/boltz_results_<input_stem>/predictions/<record_id>/…`
 * (verified against both pinned source revisions' `src/boltz/main.py` and
 * `src/boltz/data/write/writer.py`). The matcher in `outputs.ts` is segment-wise
 * (`*` per path component, no `**`), so these globs are written as four precise
 * single-segment wildcards rather than a recursive pattern.
 */
const OUTPUTS: OutputSpec[] = [
  { id: "structures", glob: "boltz_results_*/predictions/*/*.cif", required: true },
  { id: "confidence", glob: "boltz_results_*/predictions/*/confidence_*.json", required: true },
  // Only produced when an affinity checkpoint/config is used; not every job requests it.
  { id: "affinity", glob: "boltz_results_*/predictions/*/affinity_*.json", required: false },
];

/**
 * Params verified directly against the pinned CLI's `@click.option` declarations:
 * - jwohlwend/boltz @ cb04aeccdd480fd4db707f0bbafde538397fa2ac, src/boltz/main.py
 * - Novel-Therapeutics/boltz-community @ 401f18150cc7184b7e1bb37239a25035ef6b3a57, src/boltz/main.py
 *
 * `--accelerator` choices differ between the two pinned CLIs: official boltz only
 * accepts `gpu|cpu|tpu`; boltz-community additionally accepts `mps`. Both pinned
 * revisions define the remaining flags below identically. No static `default` is
 * declared for `accelerator` — see `resolveParamDefaults`.
 */
const PARAMS: ParamDescriptor[] = [
  { name: "accelerator", type: "string", enum: ["gpu", "mps", "cpu"], description: "Accelerator to use for prediction (platform-dependent default; see resolveParamDefaults)" },
  { name: "devices", type: "number", default: 1, min: 1, description: "Number of devices to use for prediction" },
  { name: "recycling_steps", type: "number", min: 0, description: "Number of recycling steps" },
  { name: "sampling_steps", type: "number", min: 1, description: "Number of diffusion sampling steps" },
  { name: "diffusion_samples", type: "number", min: 1, description: "Number of diffusion samples" },
  { name: "max_parallel_samples", type: "number", min: 1, description: "Maximum samples to predict in parallel" },
  { name: "use_msa_server", type: "boolean", description: "Use the MMSeqs2 server for MSA generation" },
  { name: "no_kernels", type: "boolean", description: "Disable custom kernels" },
  { name: "seed", type: "number", description: "Random seed (omit for no seeding)" },
];

/** Resolves the venv's `boltz` console-script entry point, installed by `uv pip install`
 * from the `[project.scripts]` `boltz = "boltz.main:cli"` entry both pinned distributions declare. */
function boltzExecutable(runtimeExecutable: string): string {
  return path.join(path.dirname(runtimeExecutable), "boltz");
}

function darwinAcceleratorError(requested: string): MoldeskError {
  return new MoldeskError({
    code: "INVALID_RUN_PARAMS",
    message: `--param accelerator=${requested} is not valid for this installation: the darwin-arm64 install uses boltz-community without CUDA support.`,
    remediation: `Use --param accelerator=mps (or omit --param accelerator to use the platform default) on darwin-arm64, or "cpu".`,
  });
}

function mpsOffDarwinError(): MoldeskError {
  return new MoldeskError({
    code: "INVALID_RUN_PARAMS",
    message: "--param accelerator=mps requires the darwin-arm64 (boltz-community) installation; the official boltz CLI's --accelerator does not accept \"mps\".",
    remediation: "Use --param accelerator=gpu (or omit --param accelerator to use the platform default) or \"cpu\" on this installation.",
  });
}

/** Minimal structural check: parses the document as real YAML (not a regex — a
 * regex like `/^sequences\s*:/m` matches on malformed documents such as
 * `sequences: [` that would fail deep inside a long Boltz run) and requires a
 * non-empty top-level `sequences` array. Not a full Boltz job-schema validator —
 * just enough to reject an obviously-invalid job before a long prediction run. */
function checkYamlJobStructure(inputPath: string, text: string): void {
  if (text.trim().length === 0) {
    throw new MoldeskError({
      code: "INVALID_RUN_INPUT",
      message: `Boltz job file is empty: ${inputPath}.`,
      remediation: "Provide a non-empty .yaml job file with a top-level `sequences` key.",
    });
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    const reason = error instanceof YAMLParseError ? error.message : String(error);
    throw new MoldeskError({
      code: "INVALID_RUN_INPUT",
      message: `Boltz job file is not valid YAML: ${inputPath}. ${reason}`,
      remediation: "Fix the YAML syntax error and retry.",
    });
  }
  const sequences = doc !== null && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as Record<string, unknown>).sequences
    : undefined;
  if (!Array.isArray(sequences) || sequences.length === 0) {
    throw new MoldeskError({
      code: "INVALID_RUN_INPUT",
      message: `Boltz job file is missing a non-empty top-level "sequences" array: ${inputPath}.`,
      remediation: "Add a top-level `sequences` key (a non-empty list) per the Boltz job schema (see examples/boltz/).",
    });
  }
}

export const boltzAdapter: ModelAdapterDefinition = {
  modelName: "boltz",
  params: PARAMS,

  async validateInput(inputPath: string): Promise<void> {
    if (!fs.existsSync(inputPath)) {
      throw new MoldeskError({
        code: "INVALID_RUN_INPUT",
        message: `Input file not found: ${inputPath}.`,
        remediation: "Provide a path to an existing .yaml, .yml, or .fasta job file.",
      });
    }
    const ext = path.extname(inputPath).toLowerCase();
    if (![".yaml", ".yml", ".fasta"].includes(ext)) {
      throw new MoldeskError({
        code: "INVALID_RUN_INPUT",
        message: `Boltz requires a .yaml, .yml, or .fasta input file, got "${ext || "(no extension)"}".`,
        remediation: "Provide a .yaml/.yml job file or a .fasta sequence file.",
      });
    }
    if (ext === ".fasta") {
      const text = fs.readFileSync(inputPath, "utf8");
      if (text.trim().length === 0) {
        throw new MoldeskError({
          code: "INVALID_RUN_INPUT",
          message: `Boltz .fasta input is empty: ${inputPath}.`,
          remediation: "Provide a non-empty FASTA file.",
        });
      }
      return;
    }
    checkYamlJobStructure(inputPath, fs.readFileSync(inputPath, "utf8"));
  },

  /**
   * `accelerator`'s correct default depends on which platform-specific runtime entry
   * was actually installed (`installed.runtime.python.platform`), not `process.platform`
   * — the installed record is the source of truth. `run.ts` calls this before
   * `validateParams` and merges the result in as an additional default.
   */
  resolveParamDefaults(context: ResolveParamDefaultsContext): Record<string, unknown> {
    const platform = context.installed.runtime.python?.platform;
    if (platform === "darwin-arm64") return { accelerator: "mps" };
    return { accelerator: "gpu" };
  },

  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return {
      steps: [
        { id: "source", description: "Fetch the pinned Boltz source revision for this platform" },
        { id: "python", description: "Create an isolated managed Python environment" },
        { id: "dependencies", description: "Install pinned Python dependencies (official boltz on Linux/CUDA, boltz-community on Darwin/MPS)" },
        { id: "postInstall", description: "Run platform-specific post-install fixups (e.g. boltz-fix-macos-libomp on Darwin)" },
        { id: "verify", description: "Verify the CLI, checkpoints, and accelerator (CUDA/MPS) availability" },
      ],
    };
  },

  async command(context: RunContext): Promise<CommandSpec> {
    const params = context.params;
    const accelerator = params.accelerator as string | undefined;
    if (accelerator === "mps" && context.platform !== "darwin-arm64") {
      throw mpsOffDarwinError();
    }
    if (accelerator === "gpu" && context.platform === "darwin-arm64") {
      throw darwinAcceleratorError("gpu");
    }

    const args: string[] = [
      "predict",
      context.inputPath,
      "--out_dir", context.outputDir,
      "--cache", path.join(context.assetsDir, "boltz-cache"),
    ];
    if (accelerator !== undefined) args.push("--accelerator", accelerator);
    if (params.devices !== undefined) args.push("--devices", String(params.devices));
    if (params.recycling_steps !== undefined) args.push("--recycling_steps", String(params.recycling_steps));
    if (params.sampling_steps !== undefined) args.push("--sampling_steps", String(params.sampling_steps));
    if (params.diffusion_samples !== undefined) args.push("--diffusion_samples", String(params.diffusion_samples));
    if (params.max_parallel_samples !== undefined) args.push("--max_parallel_samples", String(params.max_parallel_samples));
    if (params.use_msa_server === true) args.push("--use_msa_server");
    if (params.no_kernels === true) args.push("--no_kernels");
    if (params.seed !== undefined) args.push("--seed", String(params.seed));

    return { executable: boltzExecutable(context.runtimeExecutable), args };
  },

  async collectOutputs(context: RunContext): Promise<CollectedOutput[]> {
    return collectGlobOutputs(context.outputDir, OUTPUTS);
  },

  async verifyInstallation(context: InstallContext): Promise<VerificationResult> {
    const venvBin = path.join(context.modelDir, ".venv", "bin");
    const python = path.join(venvBin, "python");
    const boltzCli = path.join(venvBin, "boltz");
    const cacheDir = path.join(context.assetsDir, "boltz-cache");
    // Checkpoint/CCD assets are populated and checksum-verified at install time
    // (see manifest `assets:`), never lazily on first run — check their presence
    // here so a run never silently re-triggers an unverified download.
    const requiredFiles = [
      python,
      boltzCli,
      path.join(cacheDir, "mols"),
      path.join(cacheDir, "boltz2_conf.ckpt"),
      path.join(cacheDir, "boltz2_aff.ckpt"),
    ];
    const missing = requiredFiles.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) return { passed: false, output: `Missing ${missing.join(", ")}` };

    const runner = context.runner ?? runCommand;
    const platform = context.platform ?? detectInstalledPlatform(context.modelDir);
    const probe = platform === "darwin-arm64" ? MPS_PROBE : CUDA_PROBE;
    const result = await runner(python, ["-c", probe], { timeoutMs: 60_000 });
    if (result.code !== 0) return { passed: false, output: result.stderr.trim() };

    // The pinned CLI's --accelerator choices are baked in at build time (verified
    // against source above), but assert it here too so a future dependency
    // upgrade that silently drops "mps" from the installed CLI is caught by
    // install verification rather than surfacing only during a run.
    if (platform === "darwin-arm64") {
      const help = await runner(boltzCli, ["predict", "--help"], { timeoutMs: 30_000 });
      if (help.code !== 0 || !help.stdout.includes("mps")) {
        return { passed: false, output: `Installed boltz CLI does not advertise an "mps" --accelerator choice: ${(help.stdout || help.stderr).trim()}` };
      }
    }

    return { passed: true, output: result.stdout.trim() };
  },
};

/** Fallback for when `context.platform` isn't populated (e.g. a caller invoking
 * `verifyInstallation` directly outside the core installer): best-effort read of
 * the installed runtime's recorded platform from `installation.json`, used only
 * to pick which verification probe to run (CUDA vs MPS). Never guesses from
 * `process.platform` — falls back to CUDA probing when the record can't be read, matching
 * the Linux/CUDA path's expectations. */
function detectInstalledPlatform(modelDir: string): PlatformId | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(modelDir, "installation.json"), "utf8")) as {
      runtime?: { python?: { platform?: PlatformId } };
    };
    return raw.runtime?.python?.platform;
  } catch {
    return undefined;
  }
}

/** Pinned distribution versions (see `models/boltz/manifest.yaml`). Kept as
 * constants here, not read from the manifest at verify time, because
 * `InstallContext` doesn't carry parsed manifest data — bump alongside the
 * manifest's runtime entries' `requirements[].version`. Both distributions are
 * installed from git (source+revision), so the manifest's `version` field
 * isn't itself enforced by the installer (a hash check only applies to
 * PyPI-artifact-pinned requirements, which git-sourced ones can't be) —
 * asserting the exact installed distribution version here is what actually
 * verifies "package version and source revision correspond" (rule 1) for
 * these two requirements. */
const PINNED_BOLTZ_COMMUNITY_VERSION = "2.10.12";
const PINNED_OFFICIAL_BOLTZ_VERSION = "2.2.1";

const CUDA_PROBE = `
import torch, boltz
from importlib.metadata import version
assert torch.cuda.is_available(), "torch.cuda.is_available() is False"
assert torch.cuda.device_count() >= 1, "no CUDA devices visible"
assert torch.version.cuda is not None, "torch was not built with CUDA support (torch.version.cuda is None)"
dist_version = version("boltz")
assert dist_version == "${PINNED_OFFICIAL_BOLTZ_VERSION}", f"expected pinned boltz==${PINNED_OFFICIAL_BOLTZ_VERSION}, got {dist_version}"
print(f"cuda ok: torch={torch.__version__} cuda_build={torch.version.cuda} devices={torch.cuda.device_count()} boltz={dist_version}")
`.trim();

const MPS_PROBE = `
import platform, torch, boltz
from importlib.metadata import version, PackageNotFoundError
assert platform.system() == "Darwin", f"expected Darwin, got {platform.system()}"
assert platform.machine() == "arm64", f"expected arm64, got {platform.machine()}"
assert torch.backends.mps.is_built(), "torch was not built with MPS support"
assert torch.backends.mps.is_available(), "MPS backend is not available on this host"
x = torch.ones(4, device="mps") * 2
result = x.cpu().tolist()
assert result == [2.0, 2.0, 2.0, 2.0], f"unexpected MPS tensor op result: {result}"
try:
    dist_version = version("boltz-community")
except PackageNotFoundError:
    dist_version = None
assert dist_version is not None, "expected the boltz-community distribution to be installed, not official boltz"
assert dist_version == "${PINNED_BOLTZ_COMMUNITY_VERSION}", f"expected pinned boltz-community==${PINNED_BOLTZ_COMMUNITY_VERSION}, got {dist_version}"
try:
    official_version = version("boltz")
except PackageNotFoundError:
    official_version = None
assert official_version is None, f"official boltz distribution is also installed (version {official_version}) alongside boltz-community — both expose the same boltz import/CLI and must never coexist"
print(f"mps ok: torch={torch.__version__} boltz-community={dist_version}")
`.trim();
