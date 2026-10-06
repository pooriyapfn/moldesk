import fs from "node:fs";
import path from "node:path";
import type { CommandSpec, OutputSpec } from "@moldesk/registry";
import { MoldeskError } from "@moldesk/registry";
import { runCommand, type CompanionInputRef } from "@moldesk/runtime";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  CollectedOutput,
  InstallContext,
  InstallPlan,
  ModelAdapterDefinition,
  ParamDescriptor,
  RunContext,
  VerificationResult,
} from "../index.js";
import { collectGlobOutputs } from "../outputs.js";

/**
 * DiffDock-L's `inference.py` (gcorso/DiffDock @ 85c49b60d3e0b0182a59ee43a34a6d7036981284)
 * writes, per complex, `<out_dir>/<complex_name>/rank1.sdf` (the single top pose,
 * unsuffixed) plus `<out_dir>/<complex_name>/rank{N}_confidence{score:.2f}.sdf` for
 * every sampled pose, already sorted by descending confidence — verified directly
 * against the pinned revision's `main()`. `poses_summary` is adapter-authored (not
 * upstream), synthesized in `collectOutputs` from those filenames, so a structured,
 * checksummed rank/confidence record exists in `run.json` rather than only encoded
 * in filenames.
 */
const OUTPUTS: OutputSpec[] = [
  { id: "top_pose", glob: "*/rank1.sdf", required: true },
  { id: "ranked_poses", glob: "*/rank*_confidence*.sdf", required: true },
  { id: "poses_summary", glob: "poses_summary.json", required: true },
];

/**
 * The pinned CLI (`inference.py`) exposes no `--seed`/`--device`/`--cpu`/`--gpu`
 * flag at all — device selection is upstream's own unconditional
 * `torch.device('cuda' if torch.cuda.is_available() else 'cpu')`, and there is no
 * documented CPU support surface for this milestone (CUDA is required end-to-end;
 * see `models/diffdock/manifest.yaml`). `batch_size`/`samples_per_complex`/
 * `inference_steps` are genuine argparse flags, verified against `get_parser()`.
 */
const PARAMS: ParamDescriptor[] = [
  { name: "samples_per_complex", type: "number", default: 10, min: 1, description: "Number of docking poses to sample per complex" },
  { name: "inference_steps", type: "number", default: 20, min: 1, description: "Number of denoising steps" },
  { name: "batch_size", type: "number", default: 10, min: 1, description: "Batch size used while sampling" },
];

interface DiffdockLigand {
  path?: string;
  smiles?: string;
}

interface DiffdockJob {
  jobName?: string;
  proteinPath: string;
  ligand: DiffdockLigand;
}

function diffdockError(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

function invalidInput(message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return diffdockError("INVALID_RUN_INPUT", message, remediation, details);
}

/** Parses and structurally validates a DiffDock-L MoleculeDesk job file. Does not
 * touch the filesystem beyond `inputPath` itself — path resolution/sniffing of
 * `proteinPath`/`ligand.path` happens separately in `validateInput`. */
function parseJob(inputPath: string): DiffdockJob {
  let text: string;
  try {
    text = fs.readFileSync(inputPath, "utf8");
  } catch {
    throw invalidInput(`DiffDock-L job file not found: ${inputPath}.`, "Provide a path to an existing .json job file.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalidInput(
      `DiffDock-L job file is not valid JSON: ${inputPath}. ${error instanceof Error ? error.message : String(error)}`,
      "Fix the JSON syntax error and retry.",
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidInput(`DiffDock-L job file must be a JSON object: ${inputPath}.`, "See examples/diffdock/job.json for the expected shape.");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj["proteinPath"] !== "string" || obj["proteinPath"].trim().length === 0) {
    throw invalidInput(`DiffDock-L job file is missing a non-empty "proteinPath" string: ${inputPath}.`, "Add a top-level proteinPath pointing at a .pdb file.");
  }
  if (obj["jobName"] !== undefined && typeof obj["jobName"] !== "string") {
    throw invalidInput(`DiffDock-L job file's "jobName" must be a string: ${inputPath}.`, "Remove jobName or provide a string value.");
  }

  const ligandRaw = obj["ligand"];
  if (typeof ligandRaw !== "object" || ligandRaw === null || Array.isArray(ligandRaw)) {
    throw invalidInput(
      `DiffDock-L job file is missing a "ligand" object: ${inputPath}.`,
      'Add a top-level ligand object with exactly one of {"path": "..."} or {"smiles": "..."}.',
    );
  }
  const ligandObj = ligandRaw as Record<string, unknown>;
  const hasPath = typeof ligandObj["path"] === "string" && (ligandObj["path"] as string).trim().length > 0;
  const hasSmiles = typeof ligandObj["smiles"] === "string" && (ligandObj["smiles"] as string).trim().length > 0;
  if (hasPath === hasSmiles) {
    throw invalidInput(
      `DiffDock-L job file's "ligand" must specify exactly one of "path" or "smiles": ${inputPath}.`,
      'Provide either {"path": "ligand.sdf"} or {"smiles": "CCO"}, not both or neither.',
    );
  }

  return {
    jobName: obj["jobName"] as string | undefined,
    proteinPath: obj["proteinPath"] as string,
    ligand: hasPath ? { path: ligandObj["path"] as string } : { smiles: ligandObj["smiles"] as string },
  };
}

const SAFE_JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** DiffDock-L's own `inference.py` interpolates `--complex_name` directly into a
 * filesystem path (`f'{args.out_dir}/{name}'`) with no sanitization at all — an
 * unsanitized value could escape output confinement (e.g. `../../etc`). Never
 * derived from anything but this explicit allowlist check. */
function sanitizeJobName(rawJobName: string | undefined): string {
  if (rawJobName === undefined) return "complex_0";
  if (!SAFE_JOB_NAME_PATTERN.test(rawJobName)) {
    throw invalidInput(
      `DiffDock-L job file's "jobName" is not a safe identifier: ${JSON.stringify(rawJobName)}.`,
      "Use a plain identifier (letters, digits, '.', '_', '-'; no path separators, no leading '.', no \"..\") or omit jobName.",
    );
  }
  return rawJobName;
}

function resolveJobRelative(jobDir: string, target: string): string {
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(jobDir, target);
}

function requireRegularFile(absPath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw invalidInput(`DiffDock-L job references a missing ${label} file: ${absPath}.`, "Check the referenced path exists and retry.");
  }
  if (!stat.isFile()) {
    throw invalidInput(
      `DiffDock-L job's ${label} reference is not a regular file: ${absPath}.`,
      "Reference a regular file, not a directory — DiffDock-L jobs do not support directory inputs.",
    );
  }
}

function requireExtension(absPath: string, allowed: string[], label: string): void {
  const ext = path.extname(absPath).toLowerCase();
  if (!allowed.includes(ext)) {
    throw invalidInput(
      `DiffDock-L job's ${label} reference has an unsupported extension "${ext || "(none)"}": ${absPath}.`,
      `Use one of: ${allowed.join(", ")}.`,
    );
  }
}

const PDB_RECORD_PREFIXES = ["HEADER", "ATOM", "HETATM", "CRYST1"];

/** Practical-level sniff, not a full PDB parser — enough to reject an obviously
 * wrong file before a long install/run pipeline runs. */
function sniffPdb(absPath: string): void {
  const text = fs.readFileSync(absPath, "utf8");
  if (text.trim().length === 0) {
    throw invalidInput(`DiffDock-L protein PDB is empty: ${absPath}.`, "Provide a non-empty .pdb file.");
  }
  const hasRecord = text.split(/\r?\n/).some((line) => PDB_RECORD_PREFIXES.some((prefix) => line.startsWith(prefix)));
  if (!hasRecord) {
    throw invalidInput(
      `DiffDock-L protein file does not look like a PDB file (no HEADER/ATOM/HETATM/CRYST1 record found): ${absPath}.`,
      "Provide a real .pdb structure file.",
    );
  }
}

const SMILES_CHARSET_PATTERN = /^[A-Za-z0-9@+\-[\]().=#$:/\\%*]+$/;

/** Permissive charset/non-empty sniff, not a chemical validity check — full
 * validation happens inside the real DiffDock-L run via RDKit. */
function sniffSmiles(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !SMILES_CHARSET_PATTERN.test(trimmed)) {
    throw invalidInput(`DiffDock-L job's ligand SMILES looks invalid: ${JSON.stringify(value)}.`, "Provide a valid SMILES string, or reference a ligand file instead.");
  }
}

function findCompanion(context: RunContext, id: string): string {
  const found = context.companionInputs?.find((c) => c.id === id);
  if (!found) {
    throw diffdockError(
      "COMPANION_INPUT_NOT_STAGED",
      `Expected a staged companion input "${id}" but none was found.`,
      "This is a MoleculeDesk bug — report it.",
      { id },
    );
  }
  return found.path;
}

/**
 * `inference.py`'s own config-merge loop unconditionally overwrites
 * `args.__dict__[key]` for every key present in the `--config` YAML — including
 * keys already set from explicit CLI flags (verified directly against
 * `main()`'s `for key, value in config_dict.items(): arg_dict[key] = value`).
 * That means passing `--model_dir`/`--samples_per_complex`/etc. on argv
 * alongside the pinned source's own `default_inference_args.yaml` would be
 * silently clobbered back to that file's baked-in `./workdir/v1.1/...` relative
 * paths and defaults. To let MoleculeDesk's installed asset paths and adapter
 * params actually take effect, this strips exactly the keys that must be
 * CLI/param-controlled (`model_dir`, `confidence_model_dir`,
 * `samples_per_complex`, `inference_steps`, and `actual_steps` — which would
 * otherwise silently override `--inference_steps` per `main()`'s
 * `args.actual_steps if args.actual_steps is not None else args.inference_steps`)
 * from a copy written fresh into this run's own output directory. Every other
 * tuned sampling hyperparameter (temp_*, sigma_schedule,
 * initial_noise_std_proportion, old_filtering_model, ckpt filenames, …) is
 * carried over byte-for-byte from the installed pinned source's own file, so
 * model behavior never independently drifts from what upstream ships.
 */
function buildRunScopedConfig(sourceDir: string, outputDir: string): string {
  const upstreamConfigPath = path.join(sourceDir, "default_inference_args.yaml");
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(upstreamConfigPath, "utf8"));
  } catch (error) {
    throw diffdockError(
      "DIFFDOCK_CONFIG_UNREADABLE",
      `Could not read the installed DiffDock-L source's default_inference_args.yaml: ${upstreamConfigPath}.`,
      "Reinstall diffdock (moldesk install diffdock --reinstall).",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const doc: Record<string, unknown> = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
  for (const key of ["model_dir", "confidence_model_dir", "samples_per_complex", "inference_steps", "actual_steps"]) {
    delete doc[key];
  }
  const runConfigPath = path.join(outputDir, "moldesk-inference-config.yaml");
  fs.writeFileSync(runConfigPath, stringifyYaml(doc));
  return runConfigPath;
}

/**
 * Requires `sdfPath` to be a regular, non-empty file with a parseable,
 * positive atom count (SDF V2000 counts line, 4th line / 0-indexed [3], first
 * 3 columns). Throws rather than returning `undefined` on failure — the
 * presence of a correctly-named `rank*.sdf` file is not by itself sufficient
 * evidence of a real pose; an empty or malformed file must fail the run, not
 * silently appear in `poses_summary.json` with a missing atom count.
 */
function requireValidSdfPose(sdfPath: string, label: string): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sdfPath);
  } catch {
    throw diffdockError(
      "INVALID_RUN_OUTPUT",
      `Expected pose file is missing: ${sdfPath} (${label}).`,
      "Check stdout.log/stderr.log in the run directory for the underlying failure.",
      { sdfPath, label },
    );
  }
  if (!stat.isFile() || stat.size === 0) {
    throw diffdockError(
      "INVALID_RUN_OUTPUT",
      `Pose file "${label}" is empty or not a regular file: ${sdfPath}.`,
      "DiffDock-L produced an invalid pose; check stdout.log/stderr.log in the run directory.",
      { sdfPath, label },
    );
  }
  const lines = fs.readFileSync(sdfPath, "utf8").split(/\r?\n/);
  const countsLine = lines[3];
  const match = countsLine ? /^\s*(\d+)/.exec(countsLine) : null;
  const atomCount = match ? Number(match[1]) : 0;
  if (!(atomCount > 0)) {
    throw diffdockError(
      "INVALID_RUN_OUTPUT",
      `Pose file "${label}" has no parseable positive atom count: ${sdfPath}.`,
      "DiffDock-L produced a malformed SDF pose; check stdout.log/stderr.log in the run directory.",
      { sdfPath, label },
    );
  }
  return atomCount;
}

const RANKED_POSE_PATTERN = /^rank(\d+)_confidence(-?\d+(?:\.\d+)?)\.sdf$/;

/** Adapter-authored (not upstream) structured rank/confidence record, synthesized
 * from the ranked-pose filenames DiffDock-L itself writes. Written into `outputDir`
 * before `collectGlobOutputs` runs, so it becomes one of the declared, checksummed
 * outputs rather than leaving rank/confidence association encoded only in filenames.
 * Every pose file (including the unsuffixed top pose) is required to be a real,
 * non-empty, parseable SDF — this throws (failing the whole run) rather than
 * silently recording an invalid pose as if it were a success. */
function writePosesSummary(outputDir: string, complexName: string): void {
  const complexDir = path.join(outputDir, complexName);
  if (!fs.existsSync(complexDir)) return; // collectGlobOutputs raises MISSING_REQUIRED_OUTPUT with a clear message.
  const poses = fs
    .readdirSync(complexDir)
    .map((entry) => ({ entry, match: RANKED_POSE_PATTERN.exec(entry) }))
    .filter((x): x is { entry: string; match: RegExpExecArray } => x.match !== null)
    .map(({ entry, match }) => ({
      rank: Number(match[1]),
      confidence: Number(match[2]),
      sdfFile: entry,
      atomCount: requireValidSdfPose(path.join(complexDir, entry), entry),
    }))
    .sort((a, b) => a.rank - b.rank);
  const topPosePath = path.join(complexDir, "rank1.sdf");
  const topPoseExists = fs.existsSync(topPosePath);
  if (topPoseExists) requireValidSdfPose(topPosePath, "rank1.sdf");
  const summary = {
    complexName,
    topPoseFile: topPoseExists ? "rank1.sdf" : undefined,
    poses,
  };
  fs.writeFileSync(path.join(outputDir, "poses_summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

/**
 * Imports every pinned CUDA-extension package, then EXECUTES a minimal real
 * operator from each of torch_scatter/torch_cluster/torch_sparse ON A CUDA
 * TENSOR — not just imports them. DiffDock-L's own code genuinely calls into
 * all three directly (verified by grepping the pinned revision's
 * datasets/process_mols.py, models/aa_model.py, models/cg_model.py, and
 * utils/training.py), so exercising the same package surface here catches
 * ABI/kernel mismatches between the installed torch build and these
 * CUDA-compiled extensions that an import alone cannot — some such mismatches
 * only surface when a compiled kernel actually launches, not at import time.
 * torch_spline_conv is imported (for completeness/ABI-linkage checking) but
 * not exercised — DiffDock-L's own code never calls into it directly.
 * `scatter_add`, `radius_graph`, and `coalesce`'s call signatures below are
 * verified directly against the pinned versions' real source
 * (rusty1s/pytorch_scatter@2.1.0, rusty1s/pytorch_cluster@1.6.0,
 * rusty1s/pytorch_sparse@0.6.16) — not assumed. This exact probe has not
 * itself been executed against real CUDA hardware (none was available); spot
 * check it during the real live gate before trusting it unconditionally.
 */
const ABI_AND_CUDA_PROBE = `
import torch, torch_geometric, torch_scatter, torch_cluster, torch_sparse, torch_spline_conv, e3nn, esm
from torch_geometric.utils import degree
assert torch.cuda.is_available(), "torch.cuda.is_available() is False"
assert torch.cuda.device_count() >= 1, "no CUDA devices visible"
assert torch.version.cuda is not None, "torch was not built with CUDA support (torch.version.cuda is None)"
device = torch.device("cuda")

idx = torch.tensor([0, 0, 1, 2], device=device)
src = torch.tensor([1.0, 2.0, 3.0, 4.0], device=device)
scattered = torch_scatter.scatter_add(src, idx)
assert scattered.shape[0] == 3, f"torch_scatter.scatter_add produced unexpected shape: {tuple(scattered.shape)}"

pos = torch.rand(10, 3, device=device)
batch = torch.zeros(10, dtype=torch.long, device=device)
edges = torch_cluster.radius_graph(pos, r=0.75, batch=batch)
assert edges.dtype == torch.long, f"torch_cluster.radius_graph returned unexpected dtype: {edges.dtype}"

sparse_index = torch.tensor([[0, 1], [1, 0]], dtype=torch.long, device=device)
sparse_value = torch.tensor([1.0, 2.0], device=device)
coalesced_index, coalesced_value = torch_sparse.coalesce(sparse_index, sparse_value, m=2, n=2)
assert coalesced_index.shape[0] == 2, f"torch_sparse.coalesce produced unexpected index shape: {tuple(coalesced_index.shape)}"

print(f"cuda ops ok: torch={torch.__version__} cuda_build={torch.version.cuda} devices={torch.cuda.device_count()} pyg={torch_geometric.__version__}")
`.trim();

/**
 * `utils/so3.py` and `utils/torus.py` (both imported by `inference.py`) run heavy
 * single-core precomputations the first time they are imported (the SO(3) and
 * torus diffusion lookup tables) and cache the results as `.so3_*.npy`,
 * `.p.npy` and `.score.npy` in the *current working directory* (upstream: "the
 * precomputation is only run the first time the repository is run on a
 * machine"). MoleculeDesk runs every job with a fresh per-run working
 * directory, so without help each run would redo ~30 minutes of work. They are
 * computed once at install time into `assets/so3-cache/` and symlinked into
 * each run directory.
 */
const SO3_CACHE_FILES = [
  ".so3_omegas_array4.npy",
  ".so3_cdf_vals4.npy",
  ".so3_score_norms4.npy",
  ".so3_exp_score_norms4.npy",
  ".p.npy",
  ".score.npy",
];
const SO3_CACHE_TIMEOUT_MS = 90 * 60_000;

function so3CacheDir(assetsDir: string): string {
  return path.join(assetsDir, "so3-cache");
}

export const diffdockAdapter: ModelAdapterDefinition = {
  modelName: "diffdock",
  params: PARAMS,

  async validateInput(inputPath: string): Promise<void> {
    if (!fs.existsSync(inputPath)) {
      throw invalidInput(`Input file not found: ${inputPath}.`, "Provide a path to an existing .json job file.");
    }
    if (path.extname(inputPath).toLowerCase() !== ".json") {
      throw invalidInput(`DiffDock-L requires a .json job file, got "${path.extname(inputPath) || "(no extension)"}".`, "See examples/diffdock/job.json.");
    }
    const job = parseJob(inputPath);
    sanitizeJobName(job.jobName);

    const jobDir = path.dirname(inputPath);
    const proteinAbs = resolveJobRelative(jobDir, job.proteinPath);
    requireExtension(proteinAbs, [".pdb"], "protein");
    requireRegularFile(proteinAbs, "protein");
    sniffPdb(proteinAbs);

    if (job.ligand.path !== undefined) {
      const ligandAbs = resolveJobRelative(jobDir, job.ligand.path);
      requireExtension(ligandAbs, [".sdf", ".mol2"], "ligand");
      requireRegularFile(ligandAbs, "ligand");
    } else {
      sniffSmiles(job.ligand.smiles!);
    }
  },

  async resolveCompanionInputs(inputPath: string): Promise<CompanionInputRef[]> {
    const job = parseJob(inputPath);
    const refs: CompanionInputRef[] = [{ id: "protein", sourcePath: job.proteinPath }];
    if (job.ligand.path !== undefined) refs.push({ id: "ligand", sourcePath: job.ligand.path });
    return refs;
  },

  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return {
      steps: [
        { id: "source", description: "Fetch the pinned DiffDock-L source revision" },
        { id: "python", description: "Create an isolated managed Python environment" },
        { id: "dependencies", description: "Install pinned CUDA-specific PyTorch/PyTorch Geometric dependencies from their pinned wheel indexes" },
        { id: "assets", description: "Populate and checksum-verify the score/confidence model weights and the ESM2 language-model checkpoint" },
        { id: "verify", description: "Verify CLI help, pinned imports (ABI compatibility), installed weights, and CUDA availability" },
      ],
    };
  },

  async command(context: RunContext): Promise<CommandSpec> {
    const job = parseJob(context.inputPath);
    const complexName = sanitizeJobName(job.jobName);
    const proteinPath = findCompanion(context, "protein");
    const ligandArg = job.ligand.path !== undefined ? findCompanion(context, "ligand") : job.ligand.smiles!;

    const sourceDir = path.join(context.modelDir, "source");
    const script = path.join(sourceDir, "inference.py");
    const runConfig = buildRunScopedConfig(sourceDir, context.outputDir);
    const scoreModelDir = path.join(context.assetsDir, "diffdock-weights", "score_model");
    const confidenceModelDir = path.join(context.assetsDir, "diffdock-weights", "confidence_model");
    const torchHome = path.join(context.assetsDir, "torch-home");

    const params = context.params;
    const args: string[] = [
      script,
      "--config", runConfig,
      "--protein_path", proteinPath,
      "--ligand_description", ligandArg,
      "--complex_name", complexName,
      "--out_dir", context.outputDir,
      "--model_dir", scoreModelDir,
      "--confidence_model_dir", confidenceModelDir,
    ];
    if (params.samples_per_complex !== undefined) args.push("--samples_per_complex", String(params.samples_per_complex));
    if (params.inference_steps !== undefined) args.push("--inference_steps", String(params.inference_steps));
    if (params.batch_size !== undefined) args.push("--batch_size", String(params.batch_size));

    // ESM2's own loader (`esm.pretrained.load_model_and_alphabet`, reached
    // unconditionally on every run via InferenceDataset's `lm_embeddings=True`)
    // downloads into torch.hub's cache dir under $TORCH_HOME/hub/checkpoints/ on
    // first use. Redirected into this installation's assets dir (pre-populated
    // and checksum-verified at install time — see manifest `assets:`) so no
    // network access occurs during a run and nothing lands in an uncontrolled
    // $HOME cache.
    // Link the install-time SO(3) cache into this run's working directory (the
    // run directory, parent of outputDir) so upstream finds it instead of
    // recomputing — see SO3_CACHE_FILES.
    const runDir = path.dirname(context.outputDir);
    const cacheDir = so3CacheDir(context.assetsDir);
    for (const name of SO3_CACHE_FILES) {
      const cached = path.join(cacheDir, name);
      const link = path.join(runDir, name);
      if (fs.existsSync(cached) && !fs.existsSync(link)) fs.symlinkSync(cached, link);
    }
    return { executable: context.runtimeExecutable, args, env: { TORCH_HOME: torchHome } };
  },

  async collectOutputs(context: RunContext): Promise<CollectedOutput[]> {
    const job = parseJob(context.inputPath);
    const complexName = sanitizeJobName(job.jobName);
    // Collect the pose files BEFORE writing poses_summary.json: top_pose/
    // ranked_poses glob on `*/...` (a single-segment wildcard matching any
    // entry directly under outputDir), which would otherwise also match the
    // freshly-written poses_summary.json file itself and try to `readdir` it
    // as if it were a directory.
    const poseOutputs = collectGlobOutputs(context.outputDir, OUTPUTS.filter((o) => o.id !== "poses_summary"));
    writePosesSummary(context.outputDir, complexName);
    const summaryOutputs = collectGlobOutputs(context.outputDir, OUTPUTS.filter((o) => o.id === "poses_summary"));
    return [...poseOutputs, ...summaryOutputs];
  },

  async verifyInstallation(context: InstallContext): Promise<VerificationResult> {
    const python = path.join(context.modelDir, ".venv", "bin", "python");
    const sourceDir = path.join(context.modelDir, "source");
    const script = path.join(sourceDir, "inference.py");
    const scoreModelDir = path.join(context.assetsDir, "diffdock-weights", "score_model");
    const confidenceModelDir = path.join(context.assetsDir, "diffdock-weights", "confidence_model");
    const esmCheckpointDir = path.join(context.assetsDir, "torch-home", "hub", "checkpoints");

    // Checkpoints (DiffDock-L score/confidence weights and the ESM2 language
    // model) are populated and checksum-verified at install time (manifest
    // `assets:`), never lazily on first run — checked here so a run never
    // silently re-triggers an unverified download.
    const requiredFiles = [
      python,
      script,
      path.join(scoreModelDir, "model_parameters.yml"),
      path.join(scoreModelDir, "best_ema_inference_epoch_model.pt"),
      path.join(confidenceModelDir, "model_parameters.yml"),
      path.join(confidenceModelDir, "best_model_epoch75.pt"),
      path.join(esmCheckpointDir, "esm2_t33_650M_UR50D.pt"),
      path.join(esmCheckpointDir, "esm2_t33_650M_UR50D-contact-regression.pt"),
    ];
    const missing = requiredFiles.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) return { passed: false, output: `Missing ${missing.join(", ")}` };

    const runner = context.runner ?? runCommand;
    // Import + ABI-mismatch check for the pinned Torch/PyTorch Geometric
    // extension wheels, plus a mandatory CUDA probe — DiffDock-L is CUDA-only
    // for this milestone (see manifest hardware.nvidiaGpu/cuda: required); an
    // install where CUDA is unavailable must fail verification, not silently
    // succeed and let a run fall back to CPU (`torch.device('cuda' if
    // torch.cuda.is_available() else 'cpu')` is upstream's own selection logic).
    const probe = await runner(python, ["-c", ABI_AND_CUDA_PROBE], { timeoutMs: 120_000 });
    if (probe.code !== 0) return { passed: false, output: probe.stderr.trim() };

    // Build the one-time SO(3) cache here, in a stable directory (see SO3_CACHE_FILES).
    const cacheDir = so3CacheDir(context.assetsDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    const warm = await runner(
      python,
      ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import utils.so3, utils.torus", sourceDir],
      { cwd: cacheDir, timeoutMs: SO3_CACHE_TIMEOUT_MS },
    );
    if (warm.code !== 0) return { passed: false, output: `Failed to build DiffDock-L's SO(3)/torus cache: ${(warm.stderr || warm.stdout).trim().slice(-2000)}` };
    const uncached = SO3_CACHE_FILES.filter((name) => !fs.existsSync(path.join(cacheDir, name)));
    if (uncached.length > 0) return { passed: false, output: `DiffDock-L's SO(3)/torus cache is incomplete, missing ${uncached.join(", ")}` };

    const help = await runner(python, [script, "--help"], { cwd: cacheDir, timeoutMs: 120_000 });
    if (help.code !== 0 || !help.stdout.includes("--protein_path")) {
      return { passed: false, output: `Installed DiffDock-L CLI did not respond as expected to --help: ${(help.stdout || help.stderr).trim()}` };
    }

    return { passed: true, output: probe.stdout.trim() };
  },
};
