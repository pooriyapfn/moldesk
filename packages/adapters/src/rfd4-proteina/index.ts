import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MoldeskError } from "@moldesk/registry";
import { runCommand, type CompanionInputRef } from "@moldesk/runtime";
import type { InstallContext, ModelAdapterDefinition, ParamDescriptor, RunContext } from "../index.js";
import { collectGlobOutputs } from "../outputs.js";
import { companionRefs, fail, readSpec, resolvedSpecJson, specInputs, type ParsedSpec } from "./spec.js";
import { assertValidMmcif } from "./structure.js";
import { describeRfd4ProteinaVisualization } from "./visualization.js";

export const MODEL_NAME = "rfd4-proteina";
const PACKAGE_VERSION = "0.0.3";
const TORCH_VERSION = "2.14.1+cu126";
const RESOLVED = "moldesk-spec.json";
const SUMMARY = "moldesk-summary.json";
const BUNDLE = "rfd4-proteina-bundle";
/** The two files `Proteina.from_pretrained` reads from a local bundle directory. */
const BUNDLE_FILES: Record<string, { sha256: string; size: number }> = {
  "config.json": { sha256: "154ea927ab8005b7eac2d047a792147fb4606ab4878e496aa8414b6b40dad368", size: 7270 },
  "model.safetensors": { sha256: "5b549dd61adb2f6c6b5cb95bda13f40f5e31556b4e6c755edc0ca6f011c68fb0", size: 1742660596 },
};
/** Upstream's `compile_lengths` default; the quickstart preset nulls it to skip the compile warm-up. */
const COMPILE_LENGTHS = [128, 160, 192, 224, 256, 288, 320, 352, 384, 448, 512, 640, 768, 896, 1024];
const RECYCLE = ["thinking_low", "thinking_medium", "thinking_high"];
const MAX_REPLICATES = 32;
const MAX_BATCH = 8;
const MAX_SEED = 0xffffffff;

const OUTPUTS = [
  { id: "resolved_spec", glob: RESOLVED, required: true },
  { id: "generated_structures", glob: "inference_samples/*/*_generated.cif", required: true },
  { id: "input_structures", glob: "inference_samples/*/*_input.cif", required: false },
  { id: "summary", glob: SUMMARY, required: false },
];

const PARAMS: ParamDescriptor[] = [
  { name: "numReplicates", type: "number", integer: true, min: 1, max: MAX_REPLICATES, default: 1, description: `Designs generated per spec entry (1-${MAX_REPLICATES})` },
  { name: "batchSize", type: "number", integer: true, min: 1, max: MAX_BATCH, default: 1, description: `Designs generated at once (1-${MAX_BATCH}); raise only after one fits` },
  { name: "seed", type: "number", integer: true, min: 0, max: MAX_SEED, randomDefault: true, description: "Integer seed; a random one is chosen and recorded when omitted" },
  { name: "recycle", type: "string", enum: RECYCLE, default: "thinking_medium", description: "Upstream trunk-recycling budget preset" },
  { name: "compile", type: "boolean", default: false, description: "torch.compile warm-up; pays off only across many designs" },
];

interface EffectiveParams {
  numReplicates: number;
  batchSize: number;
  seed: number | undefined;
  recycle: string;
  compile: boolean;
}

function paramFail(message: string): never {
  return fail(message, "INVALID_RUN_PARAMS");
}

function integerIn(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    paramFail(`--param ${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/** Validated again here because `command()` must never trust that preflight ran (e.g. a fractional seed). */
function effectiveParams(params: Record<string, unknown>, requireSeed: boolean): EffectiveParams {
  const recycle = params.recycle ?? "thinking_medium";
  if (typeof recycle !== "string" || !RECYCLE.includes(recycle)) paramFail(`--param recycle must be one of ${RECYCLE.join(", ")}.`);
  const compile = params.compile ?? false;
  if (typeof compile !== "boolean") paramFail("--param compile must be true or false.");
  if (requireSeed && params.seed === undefined) paramFail("A seed is required; core fills it in before the run, so this is a MoleculeDesk bug.");
  return {
    numReplicates: integerIn(params.numReplicates ?? 1, "numReplicates", 1, MAX_REPLICATES),
    batchSize: integerIn(params.batchSize ?? 1, "batchSize", 1, MAX_BATCH),
    seed: params.seed === undefined ? undefined : integerIn(params.seed, "seed", 0, MAX_SEED),
    recycle,
    compile,
  };
}

/**
 * Hydra overrides are `key=value` strings parsed by Hydra's own grammar. An argv array already
 * prevents shell interpretation, but not Hydra interpretation: `,` `[` `=` and spaces split or
 * restructure a value, and `${...}` is an OmegaConf interpolation. Paths are quoted when they
 * contain anything but plain characters; quotes, backslashes, `$` and control characters have
 * no safe spelling here, so they fail closed rather than being escaped.
 */
export function hydraValue(value: string, label: string): string {
  // eslint-disable-next-line no-control-regex
  if (value.length === 0 || /[\u0000-\u001f\u007f'"\\$]/.test(value)) {
    fail(`${label} contains characters (quotes, backslash, "$" or control characters) that cannot be passed safely to the model's configuration system: ${JSON.stringify(value.slice(0, 80))}.`, "INVALID_RUN_PARAMS");
  }
  return /^[A-Za-z0-9_./@+-]+$/.test(value) ? value : `'${value}'`;
}

function environment(cacheDir: string): Record<string, string> {
  return {
    PYTHONNOUSERSITE: "1",
    // Public profile: never pick up a private cluster profile, and only read `.env.local`/`.env`
    // from the working directory MoleculeDesk controls (the run or job directory).
    CLUSTER: "local",
    // Weights are managed assets loaded from a local directory; nothing may reach the Hub.
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    WANDB_MODE: "disabled",
    HF_HOME: path.join(cacheDir, "huggingface"),
    XDG_CACHE_HOME: cacheDir,
    TORCH_HOME: path.join(cacheDir, "torch"),
    TORCHINDUCTOR_CACHE_DIR: path.join(cacheDir, "torchinductor"),
    TRITON_CACHE_DIR: path.join(cacheDir, "triton"),
    MPLCONFIGDIR: path.join(cacheDir, "matplotlib"),
    // Referenced only by configs that native checkpoints use; never read with a local bundle.
    DATA_PATH: path.join(cacheDir, "data-path"),
  };
}

function cacheFor(outputDir: string): string {
  return path.join(path.dirname(outputDir), "cache");
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Checks a reference against the job file's own folder. Canonicalizes the *complete* path (a
 * symlinked ancestor escapes a leaf-only check) and compares with `path.relative`, never a
 * string prefix. Core's staging repeats this immediately before copying.
 */
function checkReference(specPath: string, file: string): void {
  const root = fs.realpathSync(path.dirname(specPath));
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(path.dirname(specPath), file));
  } catch {
    return fail(`Referenced structure is missing: ${file}.`);
  }
  if (!within(root, real)) fail(`Referenced structure escapes the spec's folder: ${file}.`);
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size === 0) fail(`Referenced structure must be a non-empty regular file: ${file}.`);
}

function stagedMap(context: RunContext, spec: ParsedSpec): Map<string, string> {
  const root = fs.realpathSync(path.dirname(context.inputPath));
  const byId = new Map((context.companionInputs ?? []).map((c) => [c.id, c.path]));
  const staged = new Map<string, string>();
  for (const ref of companionRefs(spec)) {
    const file = byId.get(ref.id);
    if (!file || !fs.existsSync(file)) fail(`Missing staged structure for ${ref.sourcePath}.`);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) fail(`Staged structure is not a regular file: ${ref.sourcePath}.`);
    // Staged copies live under the run's immutable input directory, never anywhere else.
    if (!within(root, fs.realpathSync(file))) fail(`Staged structure left the run's input directory: ${ref.sourcePath}.`);
    staged.set(ref.sourcePath, file);
  }
  return staged;
}

const PROBE = `
import hashlib, importlib.metadata as md, os, shutil, subprocess, sys
assert md.version('rfd4-proteina') == '${PACKAGE_VERSION}', 'unexpected rfd4-proteina version'
for name, version in (('atomworks', '3.0.4'), ('tmol', '0.2.0'), ('cuequivariance', '0.13.0')):
    assert md.version(name) == version, f'unexpected {name} version'
import torch
assert torch.__version__ == '${TORCH_VERSION}', f'unexpected torch {torch.__version__}'
assert torch.cuda.is_available(), 'RFD4-Proteina requires CUDA; CPU fallback refused'
major, minor = torch.cuda.get_device_capability(0)
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'device', torch.cuda.get_device_name(0), f'sm_{major}{minor}', 'arch list', torch.cuda.get_arch_list(), flush=True)
assert float(torch.arange(4, dtype=torch.float32, device='cuda').sum().item()) == 6.0, 'CUDA tensor operation failed'
import rfd4_proteina, rfproteina.generate  # noqa: E401  imports the whole inference stack
bundle = sys.argv[1]
for name, expected in ${JSON.stringify(BUNDLE_FILES)}.items():
    file = os.path.join(bundle, name)
    assert os.path.isfile(file) and not os.path.islink(file), f'missing weights file: {name}'
    assert os.path.getsize(file) == expected['size'], f'wrong size: {name}'
    digest = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    assert digest.hexdigest() == expected['sha256'], f'corrupt weights file: {name}'
assert shutil.disk_usage(bundle).free >= 2 * 1024**3, 'at least 2 GiB free required for outputs and compile caches'
subprocess.run([os.path.join(os.path.dirname(sys.executable), 'rfd4-generate'), '--help'], check=True, stdout=subprocess.DEVNULL)
print('RFD4-Proteina verified', flush=True)
`;

export const rfd4ProteinaAdapter: ModelAdapterDefinition = {
  modelName: MODEL_NAME,
  params: PARAMS,
  /** A random default is chosen once, up front, so local and cloud runs record the same effective seed. */
  resolveParamDefaults() {
    return { seed: crypto.randomInt(0, MAX_SEED + 1) };
  },
  async validateInput(inputPath) {
    const spec = readSpec(inputPath);
    for (const file of specInputs(spec)) checkReference(inputPath, file);
  },
  async resolveCompanionInputs(inputPath): Promise<CompanionInputRef[]> {
    return companionRefs(readSpec(inputPath));
  },
  async installPlan() {
    return {
      steps: [
        { id: "source", description: "Fetch the pinned v0.0.3 source revision (provenance; the wheel is what runs)" },
        { id: "dependencies", description: "Install the hash-pinned rfd4-proteina 0.0.3 wheel with torch 2.14.1+cu126 and its CUDA 12 closure" },
        { id: "assets", description: "Fetch and verify the two model files (config.json, model.safetensors; about 1.7 GB)" },
        { id: "verify", description: "Check versions, a real CUDA tensor operation, the weights hashes and the CLI" },
      ],
    };
  },
  async command(context: RunContext) {
    if (context.platform !== "linux-x64") fail("RFD4-Proteina requires the Linux x64 CUDA installation.", "INVALID_RUN_PARAMS");
    const params = effectiveParams(context.params, true);
    const spec = readSpec(context.inputPath);
    const staged = stagedMap(context, spec);
    const specPath = path.join(context.outputDir, RESOLVED);
    fs.writeFileSync(specPath, resolvedSpecJson(spec, staged), { flag: "wx" });

    const bundle = path.join(context.assetsDir, BUNDLE);
    const overrides: Array<[string, string]> = [
      ["inference_experiment", "quickstart"],
      ["inputs", hydraValue(specPath, "The resolved spec path")],
      ["out_dir", hydraValue(context.outputDir, "The output directory")],
      ["hydra.run.dir", hydraValue(path.join(context.outputDir, "hydra"), "The Hydra directory")],
      // A local directory takes the no-network branch of `from_pretrained`; the pinned revision
      // is already enforced by the hashes on the two managed assets.
      ["hf_ckpt_path", hydraValue(bundle, "The weights directory")],
      ["hf_ckpt_revision", "null"],
      ["num_replicates", String(params.numReplicates)],
      ["batch_size", String(params.batchSize)],
      ["seed", String(params.seed)],
      ["recycle_strategy", params.recycle],
      ["compile_lengths", params.compile ? `[${COMPILE_LENGTHS.join(",")}]` : "null"],
      ["compress_outputs", "false"],
      ["skip_existing", "false"],
      ["prevalidate_inputs", "true"],
      ["num_workers", "0"],
      ["verbose", "false"],
    ];
    return {
      executable: path.join(path.dirname(context.runtimeExecutable), "rfd4-generate"),
      args: overrides.map(([key, value]) => `${key}=${value}`),
      env: environment(cacheFor(context.outputDir)),
    };
  },
  async collectOutputs(context) {
    // Pure TypeScript on purpose: for cloud runs this executes on the client, which has no model runtime.
    const params = effectiveParams(context.params, false);
    const spec = readSpec(context.inputPath);
    const expected = new Map<string, { design: string; replicate: number }>();
    for (const design of spec.designs) {
      for (let i = 0; i < params.numReplicates; i += 1) expected.set(`${design.name}_${i}`, { design: design.name, replicate: i });
    }

    const collected = collectGlobOutputs(context.outputDir, OUTPUTS);
    const atoms: Record<string, number> = {};
    const seen = new Set<string>();
    for (const output of collected) {
      if (output.id !== "generated_structures" && output.id !== "input_structures") continue;
      const suffix = output.id === "generated_structures" ? "_generated.cif" : "_input.cif";
      const id = path.basename(output.path).slice(0, -suffix.length);
      if (!expected.has(id) || path.basename(path.dirname(output.path)) !== id) {
        throw new MoldeskError({ code: "INVALID_RUN_OUTPUT", message: `Unexpected structure ${path.relative(context.outputDir, output.path)}.`, remediation: "Check stdout.log/stderr.log; the spec or replicate count may not match what ran." });
      }
      const count = assertValidMmcif(output.path);
      if (output.id === "generated_structures") {
        seen.add(id);
        atoms[id] = count;
      }
    }
    const missing = [...expected.keys()].filter((id) => !seen.has(id));
    if (missing.length > 0) {
      throw new MoldeskError({ code: "INVALID_RUN_OUTPUT", message: `Missing generated structure(s): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}.`, remediation: "Check stdout.log/stderr.log for the design that failed." });
    }

    const summaryPath = path.join(context.outputDir, SUMMARY);
    if (fs.existsSync(summaryPath) && fs.lstatSync(summaryPath).isSymbolicLink()) fail("The summary path is a symbolic link.", "INVALID_RUN_OUTPUT");
    const summary = {
      model: MODEL_NAME,
      designs: spec.designs.map((d) => d.name),
      parameters: params,
      structures: [...expected.keys()].map((id) => ({ id, design: expected.get(id)!.design, replicate: expected.get(id)!.replicate, atoms: atoms[id]! })),
    };
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    return collectGlobOutputs(context.outputDir, OUTPUTS);
  },
  describeVisualization(context, outputs) {
    return Promise.resolve(describeRfd4ProteinaVisualization(context.inputPath, readSpec(context.inputPath), outputs));
  },
  async verifyInstallation(context: InstallContext) {
    if (context.platform !== "linux-x64") return { passed: false, output: "RFD4-Proteina supports Linux x64/NVIDIA only." };
    const python = path.join(context.modelDir, ".venv/bin/python");
    const cache = path.join(context.modelDir, "cache");
    for (const file of [python, path.join(context.modelDir, ".venv/bin/rfd4-generate")]) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { passed: false, output: `Missing installation file: ${file}` };
    }
    const result = await (context.runner ?? runCommand)(python, ["-c", PROBE, path.join(context.assetsDir, BUNDLE)], {
      cwd: context.modelDir,
      env: { ...process.env, ...environment(cache) },
      timeoutMs: 900_000,
    });
    return { passed: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
  },
};
