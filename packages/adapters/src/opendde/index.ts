import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandSpec, OutputSpec, PlatformId } from "@moldesk/registry";
import { MoldeskError } from "@moldesk/registry";
import { runCommand, type CompanionInputRef } from "@moldesk/runtime";
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
 * Adapter-written copy of the job with every companion reference rewritten to its
 * staged path under the run's `input/` dir. Only written when the job references
 * files; pure sequence/SMILES/CCD jobs run straight from the stored input.
 */
const RESOLVED_JOB_FILE = "moldesk-resolved-job.json";

/** Written only when one or more mmCIF → PDB conversions failed. */
const PDB_EXPORT_ERRORS_FILE = "moldesk-pdb-export-errors.json";

/**
 * `opendde pred` writes `<out_dir>/<job_name>/seed_<seed>/predictions/…`
 * (`runner/dumper.py` `_get_dump_dir` with `group_name=""`, and the file names in
 * `_save_structure`/`_save_confidence` at aurekaresearch/OpenDDE @
 * ddfa1df8aff1babf1fddac4247b7d2351bd0ce9f). Must match `models/opendde/manifest.yaml`.
 */
const OUTPUTS: OutputSpec[] = [
  { id: "structures", glob: "*/seed_*/predictions/*_sample_*.cif", required: true },
  { id: "confidence", glob: "*/seed_*/predictions/*_summary_confidence_sample_*.json", required: true },
  { id: "atom_confidence", glob: "*/seed_*/predictions/*_full_data_sample_*.json", required: false },
  // Adapter-written PDB conversions of each mmCIF (see `exportPdb`).
  { id: "structures_pdb", glob: "*/seed_*/predictions/*_sample_*.pdb", required: false },
  { id: "pdb_export_errors", glob: PDB_EXPORT_ERRORS_FILE, required: false },
  { id: "resolved_job", glob: RESOLVED_JOB_FILE, required: false },
];

const MAX_SEED = 2 ** 32 - 1;

/**
 * Params verified against the pinned `runner/batch_inference.py` `predict`
 * click options. Defaults are a bounded, offline smoke-test configuration: one
 * sample, upstream's standard 200 steps / 10 cycles, and no MSA/template/RNA-MSA
 * search (so neither the public ColabFold server nor any search database is
 * touched). No static `device` default — see `resolveParamDefaults`.
 */
const PARAMS: ParamDescriptor[] = [
  { name: "device", type: "string", enum: ["auto", "mps", "cuda", "cpu"], description: "Inference device (platform-dependent default; auto resolves to the installed accelerator, never CPU)" },
  { name: "samples", type: "number", default: 1, min: 1, description: "Number of diffusion samples (--sample)" },
  { name: "steps", type: "number", default: 200, min: 1, description: "Diffusion steps (--step)" },
  { name: "cycles", type: "number", default: 10, min: 1, description: "Pairformer cycles (--cycle)" },
  { name: "seed", type: "number", min: 0, max: MAX_SEED, description: "Seed (--seeds); overrides the job's modelSeeds" },
  { name: "use_msa", type: "boolean", default: false, description: "Use protein MSA (precomputed A3M paths in the job, else the public ColabFold server)" },
  { name: "use_template", type: "boolean", default: false, description: "Use templates (not supported by MoleculeDesk yet; must stay false)" },
  { name: "use_rna_msa", type: "boolean", default: false, description: "Use RNA MSA (requires a precomputed unpairedMsaPath on every rnaSequence)" },
  { name: "deterministic", type: "boolean", default: false, description: "Enable deterministic PyTorch algorithms" },
];

const INTEGER_PARAMS = ["samples", "steps", "cycles", "seed"];

/** Pinned versions (see `models/opendde/manifest.yaml`); bump together. */
const PINNED_OPENDDE_VERSION = "1.1.1";
const PINNED_TORCH_VERSION = "2.7.1";

/**
 * Installed assets and their published identity, mirrored from the manifest's
 * `assets:` (which in turn mirror upstream's `opendde/config/model_manifest.json`
 * and `dependency_url.py` MANAGED_ASSETS). `InstallContext` carries no parsed
 * manifest, so these are constants here, as for Boltz's pinned versions.
 */
const MANAGED_ASSETS = [
  { relPath: "checkpoint/opendde.pt", sizeBytes: 2_625_249_069, sha256: "7b826620390afad877ee2babc6a4d0df81b94d3a0be030959853d6a7da0807cc" },
  { relPath: "common/components.cif", sizeBytes: 490_777_362, sha256: "bb31ae5cf6c8bc669924313077cb4231ee5ffefd3a20118cd14f3ec89f8bb6a5" },
  { relPath: "common/components.cif.rdkit_mol.pkl", sizeBytes: 142_498_117, sha256: "d1cfb71f5993a3ebea7c47877022d7f597bbfbaf86e28a4770e957da6c50cd35" },
];

/**
 * Upstream falls back to downloading any missing/wrong-sized managed asset from
 * these roots. Pointing them at a reserved, never-resolvable domain (RFC 2606
 * `.invalid`) turns that silent download into an immediate failure, so a run can
 * only ever use the install-time-verified files.
 */
const DOWNLOADS_DISABLED_URL = "https://downloads-disabled.moldesk.invalid";

const ENTITY_KEYS = ["proteinChain", "dnaSequence", "rnaSequence", "ligand", "ion"] as const;

/** Upstream's own `validate_sample_name` only forbids separators/`.`/`..`/`err`; this
 * is stricter so a job name is always a plain directory segment under `output/`. */
const SAFE_JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Json = Record<string, unknown>;

interface OpenddeJob {
  name: string;
  sequences: Json[];
}

type CompanionKind = "paired-msa" | "unpaired-msa" | "templates" | "ligand-file";

interface FileReference {
  /** Staging id, also a path segment: `j<job>-s<entity>-<kind>`. */
  id: string;
  jobIndex: number;
  sequenceIndex: number;
  entityKey: string;
  field: string;
  kind: CompanionKind;
  /** The path exactly as written in the job (without the ligand `FILE_` prefix). */
  sourcePath: string;
}

const ALLOWED_EXTENSIONS: Record<CompanionKind, string[]> = {
  "paired-msa": [".a3m"],
  "unpaired-msa": [".a3m"],
  templates: [".a3m", ".hhr"],
  "ligand-file": [".pdb", ".sdf", ".mol", ".mol2"],
};

function openddeError(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

function invalidInput(message: string, remediation: string): MoldeskError {
  return openddeError("INVALID_RUN_INPUT", message, remediation);
}

function invalidParams(message: string, remediation: string): MoldeskError {
  return openddeError("INVALID_RUN_PARAMS", message, remediation);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSeed(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= MAX_SEED;
  // Upstream accepts quoted decimal seeds for compatibility.
  return typeof value === "string" && /^\d+$/.test(value) && Number(value) <= MAX_SEED;
}

/**
 * Parses and structurally validates an OpenDDE job file (a non-empty top-level list
 * of jobs, per upstream `docs/infer_json_format.md` and `validate_inference_jobs`).
 * Enough to reject an obviously invalid job before loading a 2.6 GB checkpoint;
 * sequence/chemistry validity is left to upstream.
 */
function parseJobs(inputPath: string): OpenddeJob[] {
  let text: string;
  try {
    text = fs.readFileSync(inputPath, "utf8");
  } catch {
    throw invalidInput(`OpenDDE job file not found: ${inputPath}.`, "Provide a path to an existing .json job file.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalidInput(
      `OpenDDE job file is not valid JSON: ${inputPath}. ${error instanceof Error ? error.message : String(error)}`,
      "Fix the JSON syntax error and retry.",
    );
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidInput(
      `OpenDDE job file must be a non-empty top-level JSON list of jobs: ${inputPath}.`,
      "Wrap the job in a list: [{\"name\": ..., \"sequences\": [...]}] (see examples/opendde/tiny.json).",
    );
  }

  const seen = new Set<string>();
  return raw.map((job, jobIndex): OpenddeJob => {
    if (!isObject(job)) {
      throw invalidInput(`OpenDDE job ${jobIndex} must be a JSON object: ${inputPath}.`, "See examples/opendde/tiny.json for the expected shape.");
    }
    const name = job["name"];
    if (typeof name !== "string" || !SAFE_JOB_NAME_PATTERN.test(name) || name.toLowerCase() === "err" || name === RESOLVED_JOB_FILE) {
      throw invalidInput(
        `OpenDDE job ${jobIndex} has a missing or unsafe "name": ${JSON.stringify(name)}.`,
        "Use a plain identifier (letters, digits, '.', '_', '-'; not starting with '.', not \"err\").",
      );
    }
    if (seen.has(name)) {
      throw invalidInput(`OpenDDE job name "${name}" is duplicated; outputs would collide.`, "Give every job in the file a unique name.");
    }
    seen.add(name);

    const modelSeeds = job["modelSeeds"];
    if (modelSeeds !== undefined && (!Array.isArray(modelSeeds) || !modelSeeds.every(isValidSeed))) {
      throw invalidInput(
        `OpenDDE job "${name}" has an invalid "modelSeeds" (expected a list of integers in [0, ${MAX_SEED}]).`,
        "Fix modelSeeds, or remove it and pass --param seed=<n>.",
      );
    }

    const sequences = job["sequences"];
    if (!Array.isArray(sequences) || sequences.length === 0) {
      throw invalidInput(`OpenDDE job "${name}" is missing a non-empty "sequences" list.`, "Add at least one entity (e.g. a proteinChain).");
    }
    sequences.forEach((entity, sequenceIndex) => {
      const keys = isObject(entity) ? Object.keys(entity) : [];
      if (keys.length !== 1 || !(ENTITY_KEYS as readonly string[]).includes(keys[0]!) || !isObject(entity[keys[0]!])) {
        throw invalidInput(
          `OpenDDE job "${name}" sequences[${sequenceIndex}] must contain exactly one entity object (${ENTITY_KEYS.join(", ")}).`,
          "See upstream docs/infer_json_format.md.",
        );
      }
    });
    return { name, sequences: sequences as Json[] };
  });
}

function stringField(entity: Json, field: string, label: string): string | undefined {
  const value = entity[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(`OpenDDE ${label} "${field}" must be a non-empty path string.`, "Fix or remove the field.");
  }
  return value;
}

/**
 * Every file an OpenDDE job can reference, per the pinned revision's readers:
 * `proteinChain.pairedMsaPath`/`unpairedMsaPath`/`templatesPath`,
 * `rnaSequence.unpairedMsaPath`, and a `ligand.ligand` value prefixed `FILE_`.
 * The legacy `proteinChain.msa` form (which names a *directory*) is rejected
 * outright — directory inputs cannot be staged.
 */
function collectFileReferences(jobs: OpenddeJob[]): FileReference[] {
  const refs: FileReference[] = [];
  jobs.forEach((job, jobIndex) => {
    job.sequences.forEach((wrapper, sequenceIndex) => {
      const entityKey = Object.keys(wrapper)[0]!;
      const entity = wrapper[entityKey] as Json;
      const label = `job "${job.name}" sequences[${sequenceIndex}].${entityKey}`;
      const add = (field: string, kind: CompanionKind, sourcePath: string | undefined) => {
        if (sourcePath === undefined) return;
        refs.push({ id: `j${jobIndex}-s${sequenceIndex}-${kind}`, jobIndex, sequenceIndex, entityKey, field, kind, sourcePath });
      };
      if (entityKey === "proteinChain") {
        if (entity["msa"] !== undefined) {
          throw invalidInput(
            `OpenDDE ${label} uses the legacy "msa" field, which references a directory.`,
            "Use pairedMsaPath/unpairedMsaPath pointing at .a3m files instead.",
          );
        }
        add("pairedMsaPath", "paired-msa", stringField(entity, "pairedMsaPath", label));
        add("unpairedMsaPath", "unpaired-msa", stringField(entity, "unpairedMsaPath", label));
        add("templatesPath", "templates", stringField(entity, "templatesPath", label));
      } else if (entityKey === "rnaSequence") {
        add("unpairedMsaPath", "unpaired-msa", stringField(entity, "unpairedMsaPath", label));
      } else if (entityKey === "ligand") {
        const value = entity["ligand"];
        if (typeof value !== "string" || value.trim().length === 0) {
          throw invalidInput(`OpenDDE ${label} needs a non-empty "ligand" string (CCD_…, FILE_…, or SMILES).`, "See upstream docs/infer_json_format.md.");
        }
        if (value.startsWith("FILE_")) {
          const filePath = value.slice("FILE_".length);
          if (filePath.trim().length === 0) throw invalidInput(`OpenDDE ${label} has an empty FILE_ ligand path.`, "Use FILE_<path to .sdf/.mol/.mol2/.pdb>.");
          add("ligand", "ligand-file", filePath);
        }
      }
    });
  });
  return refs;
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Early, lexical checks so an obviously bad reference fails before a run directory
 * exists. `stageCompanionInputs` repeats confinement (incl. symlinks) at copy time. */
function checkReference(jobDir: string, ref: FileReference): void {
  const resolved = path.resolve(jobDir, ref.sourcePath);
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS[ref.kind].includes(ext)) {
    throw invalidInput(
      `OpenDDE ${ref.entityKey}.${ref.field} reference has an unsupported extension "${ext || "(none)"}": ${ref.sourcePath}.`,
      `Use one of: ${ALLOWED_EXTENSIONS[ref.kind].join(", ")}.`,
    );
  }
  if (!isWithin(jobDir, resolved)) {
    throw openddeError(
      "UNSAFE_COMPANION_INPUT_PATH",
      `OpenDDE ${ref.entityKey}.${ref.field} reference resolves outside the job file's directory: ${ref.sourcePath}.`,
      "Place referenced files alongside (or below) the job file and use relative paths.",
      { sourcePath: ref.sourcePath, resolved, jobDir },
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw invalidInput(`OpenDDE job references a missing file: ${resolved}.`, "Check the referenced path exists and retry.");
  }
  if (!stat.isFile() || stat.size === 0) {
    throw invalidInput(`OpenDDE job reference is not a non-empty regular file: ${resolved}.`, "Reference a regular, non-empty file — directories are not supported.");
  }
}

/** Writes the job with every file reference replaced by its staged absolute path. */
function writeResolvedJob(context: RunContext, refs: FileReference[]): string {
  const staged = new Map((context.companionInputs ?? []).map((c) => [c.id, c.path]));
  // Same bytes `parseJobs` just validated, so the ref indices line up.
  const doc = JSON.parse(fs.readFileSync(context.inputPath, "utf8")) as Json[];
  for (const ref of refs) {
    const stagedPath = staged.get(ref.id);
    if (stagedPath === undefined) {
      throw openddeError(
        "COMPANION_INPUT_NOT_STAGED",
        `Expected a staged companion input "${ref.id}" but none was found.`,
        "This is a MoleculeDesk bug — report it.",
        { id: ref.id },
      );
    }
    const entity = (doc[ref.jobIndex]!["sequences"] as Json[])[ref.sequenceIndex]![ref.entityKey] as Json;
    entity[ref.field] = ref.kind === "ligand-file" ? `FILE_${stagedPath}` : stagedPath;
  }
  const target = path.join(context.outputDir, RESOLVED_JOB_FILE);
  // "wx": never overwrite — the output dir is freshly allocated per run.
  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx" });
  return target;
}

/**
 * Maps the `device` param to an explicit upstream `--device`. `auto` is resolved
 * here to the installed runtime's accelerator rather than passed through, because
 * upstream's own `auto` silently falls back to CPU when CUDA/MPS is unavailable.
 * An explicit `mps`/`cuda` fails closed upstream (`select_torch_device` raises).
 */
function resolveDevice(requested: string | undefined, platform: PlatformId | undefined): "mps" | "cuda" | "cpu" {
  const device = requested ?? "auto";
  if (device === "cpu") return "cpu";
  if (device === "auto") {
    if (platform === "darwin-arm64") return "mps";
    if (platform === "linux-x64") return "cuda";
    throw invalidParams(
      "--param device=auto cannot be resolved: the installed runtime's platform is unknown.",
      "Pass --param device=mps (Apple Silicon), device=cuda (Linux/NVIDIA), or device=cpu explicitly, or reinstall opendde.",
    );
  }
  if (device === "mps" && platform !== "darwin-arm64") {
    throw invalidParams(
      "--param device=mps requires the darwin-arm64 installation of OpenDDE.",
      "Use --param device=cuda (or omit --param device) on Linux, or device=cpu.",
    );
  }
  if (device === "cuda" && platform === "darwin-arm64") {
    throw invalidParams(
      "--param device=cuda is not valid for the darwin-arm64 installation (no CUDA build).",
      "Use --param device=mps (or omit --param device) on Apple Silicon, or device=cpu.",
    );
  }
  if (device !== "mps" && device !== "cuda") {
    throw invalidParams(`Unsupported --param device=${device}.`, "Use auto, mps, cuda, or cpu.");
  }
  return device;
}

function checkParams(params: Record<string, unknown>, jobs: OpenddeJob[]): void {
  for (const name of INTEGER_PARAMS) {
    const value = params[name];
    if (value !== undefined && !Number.isInteger(value)) {
      throw invalidParams(`--param ${name} must be an integer, got ${String(value)}.`, `Pass a whole number for ${name}.`);
    }
  }
  if (params.use_template === true) {
    throw invalidParams(
      "--param use_template=true is not supported by MoleculeDesk yet: template featurization needs the template search databases and fetches PDB mmCIF files at run time, neither of which this installation provisions.",
      "Omit use_template (default false).",
    );
  }
  if (params.use_rna_msa === true) {
    for (const job of jobs) {
      job.sequences.forEach((wrapper, index) => {
        const rna = wrapper["rnaSequence"] as Json | undefined;
        if (rna !== undefined && typeof rna["unpairedMsaPath"] !== "string") {
          throw invalidParams(
            `--param use_rna_msa=true needs a precomputed unpairedMsaPath on every rnaSequence; job "${job.name}" sequences[${index}] has none, and the RNA search databases (~90 GB) are not installed.`,
            "Add unpairedMsaPath (.a3m) to each rnaSequence, or omit use_rna_msa.",
          );
        }
      });
    }
  }
}

function openddeExecutable(runtimeExecutable: string): string {
  return path.join(path.dirname(runtimeExecutable), "opendde");
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function looksLikeMmcif(text: string): boolean {
  return /^data_\S*/m.test(text) && text.includes("_atom_site.");
}

/** Every job in the submitted file must have produced at least one parseable
 * structure and confidence summary; a partially successful multi-job run is not
 * reported as success. */
function validateJobOutputs(outputDir: string, jobs: OpenddeJob[], collected: CollectedOutput[]): void {
  for (const job of jobs) {
    const prefix = path.join(outputDir, job.name) + path.sep;
    const ofJob = (id: string) => collected.filter((o) => o.id === id && o.path.startsWith(prefix));
    const structures = ofJob("structures");
    const confidences = ofJob("confidence");
    if (structures.length === 0 || confidences.length === 0) {
      throw openddeError(
        "MISSING_REQUIRED_OUTPUT",
        `OpenDDE produced no ${structures.length === 0 ? "structure" : "confidence summary"} for job "${job.name}".`,
        "Check stdout.log/stderr.log in the run directory for the underlying failure.",
        { job: job.name },
      );
    }
    for (const output of structures) {
      const text = fs.readFileSync(output.path, "utf8");
      if (!looksLikeMmcif(text)) {
        throw openddeError("INVALID_RUN_OUTPUT", `Structure is empty or not an mmCIF file: ${output.path}.`, "Check stdout.log/stderr.log in the run directory.", { path: output.path });
      }
    }
    for (const output of confidences) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(output.path, "utf8"));
      } catch {
        parsed = undefined;
      }
      if (!isObject(parsed)) {
        throw openddeError("INVALID_RUN_OUTPUT", `Confidence summary is not a JSON object: ${output.path}.`, "Check stdout.log/stderr.log in the run directory.", { path: output.path });
      }
    }
  }
}

/**
 * mmCIF → PDB with the installed environment's biotite (an exact opendde
 * dependency, `biotite==1.4.0`), keeping per-atom pLDDT in the B-factor column
 * and writing CONECT records for ligand bonds. Paths are passed as argv, never
 * interpolated into the script. Legacy PDB can't represent every structure
 * (>99,999 atoms, multi-character chain IDs), so a per-file failure doesn't fail
 * an otherwise valid prediction: it is recorded in `moldesk-pdb-export-errors.json`
 * (a declared, checksummed output) and the mmCIF remains the primary result.
 */
const PDB_EXPORT_SCRIPT = `
import json, sys
import biotite.structure.io.pdb as pdb
import biotite.structure.io.pdbx as pdbx
errors = {}
for cif in sys.argv[1:]:
    try:
        atoms = pdbx.get_structure(pdbx.CIFFile.read(cif), model=1, extra_fields=["b_factor"], include_bonds=True)
        out = pdb.PDBFile()
        out.set_structure(atoms)
        out.write(cif[:-len(".cif")] + ".pdb")
    except Exception as exc:
        errors[cif] = f"{type(exc).__name__}: {exc}"
print(json.dumps(errors))
`.trim();

async function exportPdb(context: RunContext, cifPaths: string[]): Promise<void> {
  if (cifPaths.length === 0) return;
  const runner = context.runner ?? runCommand;
  const result = await runner(context.runtimeExecutable, ["-c", PDB_EXPORT_SCRIPT, ...cifPaths], { timeoutMs: 10 * 60_000 });
  let errors: Record<string, string>;
  try {
    errors = result.code === 0 ? (JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as Record<string, string>) : {};
  } catch {
    errors = {};
  }
  if (result.code !== 0) {
    for (const cif of cifPaths) errors[cif] = `PDB export process failed (exit ${result.code}): ${result.stderr.trim().slice(-500)}`;
  }
  if (Object.keys(errors).length === 0) return;
  const relative = Object.fromEntries(Object.entries(errors).map(([cif, message]) => [path.relative(context.outputDir, cif), message]));
  fs.writeFileSync(path.join(context.outputDir, PDB_EXPORT_ERRORS_FILE), `${JSON.stringify(relative, null, 2)}\n`, { flag: "wx" });
}

export const openddeAdapter: ModelAdapterDefinition = {
  modelName: "opendde",
  params: PARAMS,

  async validateInput(inputPath: string): Promise<void> {
    if (!fs.existsSync(inputPath)) {
      throw invalidInput(`Input file not found: ${inputPath}.`, "Provide a path to an existing .json job file.");
    }
    if (path.extname(inputPath).toLowerCase() !== ".json") {
      throw invalidInput(`OpenDDE requires a .json job file, got "${path.extname(inputPath) || "(no extension)"}".`, "See examples/opendde/tiny.json.");
    }
    const jobs = parseJobs(inputPath);
    const jobDir = path.dirname(path.resolve(inputPath));
    for (const ref of collectFileReferences(jobs)) checkReference(jobDir, ref);
  },

  async resolveCompanionInputs(inputPath: string): Promise<CompanionInputRef[]> {
    return collectFileReferences(parseJobs(inputPath)).map((ref) => ({ id: ref.id, sourcePath: ref.sourcePath }));
  },

  resolveParamDefaults(context: ResolveParamDefaultsContext): Record<string, unknown> {
    const platform = context.installed.runtime.python?.platform;
    if (platform === "darwin-arm64") return { device: "mps" };
    if (platform === "linux-x64") return { device: "cuda" };
    return {};
  },

  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return {
      steps: [
        { id: "source", description: "Fetch the pinned OpenDDE v1.1.1 source revision" },
        { id: "python", description: "Create an isolated managed Python 3.11 environment" },
        { id: "dependencies", description: "Install hash-pinned opendde==1.1.1 and torch==2.7.1 (MPS build on Apple Silicon; cu126 + cuEquivariance on Linux/NVIDIA)" },
        { id: "assets", description: "Populate and checksum-verify the opendde_v1 checkpoint and CCD runtime files" },
        { id: "verify", description: "Verify asset digests, imports, the CLI, and the accelerator (MPS/CUDA)" },
      ],
    };
  },

  async command(context: RunContext): Promise<CommandSpec> {
    const jobs = parseJobs(context.inputPath);
    const params = context.params;
    checkParams(params, jobs);
    const device = resolveDevice(params.device as string | undefined, context.platform);

    const refs = collectFileReferences(jobs);
    const jobPath = refs.length > 0 ? writeResolvedJob(context, refs) : context.inputPath;

    const rootDir = path.join(context.assetsDir, "opendde-root");
    const args: string[] = [
      "pred",
      "-i", jobPath,
      "-o", context.outputDir,
      "-n", "opendde_v1",
      "--load_checkpoint_path", path.join(rootDir, "checkpoint", "opendde.pt"),
      "--device", device,
      "--dtype", "fp32",
      "--sample", String(params.samples ?? 1),
      "--step", String(params.steps ?? 200),
      "--cycle", String(params.cycles ?? 10),
      "--use_msa", String(params.use_msa === true),
      "--use_template", "false",
      "--use_rna_msa", String(params.use_rna_msa === true),
      "--deterministic", String(params.deterministic === true),
    ];
    if (params.seed !== undefined) args.push("--seeds", String(params.seed));

    return {
      executable: openddeExecutable(context.runtimeExecutable),
      args,
      env: {
        OPENDDE_ROOT_DIR: rootDir,
        OPENDDE_DEPENDENCY_URL: DOWNLOADS_DISABLED_URL,
        OPENDDE_COMMON_URL: DOWNLOADS_DISABLED_URL,
        OPENDDE_SEARCH_DATABASE_URL: DOWNLOADS_DISABLED_URL,
      },
    };
  },

  async collectOutputs(context: RunContext): Promise<CollectedOutput[]> {
    const jobs = parseJobs(context.inputPath);
    const upstreamOutputs = OUTPUTS.filter((o) => o.id !== "structures_pdb" && o.id !== "pdb_export_errors");
    const collected = collectGlobOutputs(context.outputDir, upstreamOutputs);
    validateJobOutputs(context.outputDir, jobs, collected);
    await exportPdb(context, collected.filter((o) => o.id === "structures").map((o) => o.path));
    return collectGlobOutputs(context.outputDir, OUTPUTS);
  },

  async verifyInstallation(context: InstallContext): Promise<VerificationResult> {
    const venvBin = path.join(context.modelDir, ".venv", "bin");
    const python = path.join(venvBin, "python");
    const cli = path.join(venvBin, "opendde");
    const rootDir = path.join(context.assetsDir, "opendde-root");

    const missing = [python, cli, ...MANAGED_ASSETS.map((a) => path.join(rootDir, a.relPath))].filter((file) => !fs.existsSync(file));
    if (missing.length > 0) return { passed: false, output: `Missing ${missing.join(", ")}` };

    for (const asset of MANAGED_ASSETS) {
      const file = path.join(rootDir, asset.relPath);
      const size = fs.statSync(file).size;
      if (size !== asset.sizeBytes) return { passed: false, output: `${file}: expected ${asset.sizeBytes} bytes, got ${size}` };
    }

    const platform = context.platform ?? detectInstalledPlatform(context.modelDir);
    if (platform !== "darwin-arm64" && platform !== "linux-x64") {
      return { passed: false, output: "Cannot determine the installed OpenDDE platform to select an accelerator probe." };
    }
    const runner = context.runner ?? runCommand;
    const probe = await runner(python, ["-c", platform === "darwin-arm64" ? MPS_PROBE : CUDA_PROBE], { timeoutMs: 120_000 });
    if (probe.code !== 0) return { passed: false, output: (probe.stderr || probe.stdout).trim() };

    const help = await runner(cli, ["pred", "--help"], { timeoutMs: 120_000 });
    const expectedDevice = platform === "darwin-arm64" ? "mps" : "cuda";
    const missingFlags = ["--device", "--load_checkpoint_path", "--use_msa", "--seeds", expectedDevice].filter((flag) => !help.stdout.includes(flag));
    if (help.code !== 0 || missingFlags.length > 0) {
      return { passed: false, output: `Installed opendde CLI did not advertise ${missingFlags.join(", ") || "a usable pred command"}: ${(help.stdout || help.stderr).trim()}` };
    }

    // Digest last (it reads ~3.3 GB): upstream's own runtime check is size-only,
    // so this is where content integrity of the installed files is established.
    for (const asset of MANAGED_ASSETS) {
      const file = path.join(rootDir, asset.relPath);
      const digest = await sha256File(file);
      if (digest !== asset.sha256) return { passed: false, output: `${file}: expected sha256 ${asset.sha256}, got ${digest}` };
    }

    return { passed: true, output: probe.stdout.trim() };
  },
};

/** Best-effort read of the installed runtime's platform from `installation.json` when
 * `context.platform` isn't supplied; never guessed from `process.platform`. */
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

const VERSION_ASSERTIONS = `
from importlib.metadata import version
import torch, opendde, runner.batch_inference
opendde_version = version("opendde")
assert opendde_version == "${PINNED_OPENDDE_VERSION}", f"expected pinned opendde==${PINNED_OPENDDE_VERSION}, got {opendde_version}"
assert torch.__version__.split("+")[0] == "${PINNED_TORCH_VERSION}", f"expected torch ${PINNED_TORCH_VERSION}, got {torch.__version__}"
`.trim();

const MPS_PROBE = `
import platform
${VERSION_ASSERTIONS}
assert platform.system() == "Darwin", f"expected Darwin, got {platform.system()}"
assert platform.machine() == "arm64", f"expected arm64, got {platform.machine()}"
assert torch.backends.mps.is_built(), "torch was not built with MPS support"
assert torch.backends.mps.is_available(), "MPS backend is not available on this host"
x = torch.arange(4, dtype=torch.float32, device="mps")
y = (x @ x).item()
assert y == 14.0, f"unexpected MPS tensor op result: {y}"
print(f"mps ok: torch={torch.__version__} opendde={opendde_version} op={y}")
`.trim();

const CUDA_PROBE = `
${VERSION_ASSERTIONS}
import cuequivariance_torch
assert torch.version.cuda is not None, "torch was not built with CUDA support (torch.version.cuda is None)"
assert torch.cuda.is_available(), "torch.cuda.is_available() is False"
assert torch.cuda.device_count() >= 1, "no CUDA devices visible"
x = torch.arange(4, dtype=torch.float32, device="cuda")
y = (x @ x).item()
assert y == 14.0, f"unexpected CUDA tensor op result: {y}"
print(f"cuda ok: torch={torch.__version__} cuda_build={torch.version.cuda} devices={torch.cuda.device_count()} device0={torch.cuda.get_device_name(0)} opendde={opendde_version}")
`.trim();
