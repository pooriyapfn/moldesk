import fs from "node:fs";
import path from "node:path";
import { MoldeskError, type OutputSpec } from "@moldesk/registry";
import { runCommand, type CompanionInputRef } from "@moldesk/runtime";
import type { ModelAdapterDefinition, RunContext, InstallContext } from "../index.js";
import { collectGlobOutputs } from "../outputs.js";

const MODALITIES = ["binder", "peptide", "cyclic_peptide", "VHH", "ARP"];
const RESOLVED = "moldesk-campaign.json";
const SUMMARY = "moldesk-summary.json";
const AF_MODELS = ["model_1_multimer_v3", "model_2_multimer_v3", "model_3_multimer_v3", "model_4_multimer_v3", "model_5_multimer_v3", "model_1_ptm", "model_2_ptm"];
const AF_HASHES: Record<string, { size: number; sha256: string }> = {
  "model_1_multimer_v3": {
    "size": 373043148,
    "sha256": "611da8fc7478928f68de12e8b226260ef1f4ce62bcc29b008572e52f4f212959"
  },
  "model_2_multimer_v3": {
    "size": 373043148,
    "sha256": "51362b0844382ae0f5720c59b81dd13a43eea40fbf9995dd2573bdab88865378"
  },
  "model_3_multimer_v3": {
    "size": 373043148,
    "sha256": "46d9bcad288edc7ad5a6362ee8e5f84307a69712e00e6c36b1ef9daf96ebc9ce"
  },
  "model_4_multimer_v3": {
    "size": 373043148,
    "sha256": "59bdabd2d69c07fe26b37882d544acbd1b9f89f196828f4220da49e0610b572c"
  },
  "model_5_multimer_v3": {
    "size": 373043148,
    "sha256": "917742be5a105d6b80f13f1f13f20459f27ec3fdcd34ea088b359f4502d6177f"
  },
  "model_1_ptm": {
    "size": 373103340,
    "sha256": "5e564f79af5bcd54ccef6e2a6bb0ff01015d01650ebc41d4575e35f0de9ecc84"
  },
  "model_2_ptm": {
    "size": 373103340,
    "sha256": "23645d9a82c4af2ed54cd48a7b3c1c2575dc6aa9fe931adb4d7203ca5f0dc398"
  }
};
const MPNN_HASHES: Record<string, string> = {
  neutral: "58db738bbf867ca9b9290ce3a6581b94649f108683ac0e6a10de6b4aeeed30b4",
  negative: "b166276f80a45cb3de24bceb3b47b2f47a60ff654660f09837cd775846411ad1",
  positive: "9b8b55fcb8a428ba85f583be828d1a8d14ab2fe0e02474979c3dcbae146795f5",
};
const OUTPUTS: OutputSpec[] = [
  { id: "campaign", glob: RESOLVED, required: true },
  { id: "metadata", glob: "campaign_metadata.json", required: true },
  { id: "trajectories", glob: "1_Trajectories/!_Trajectories.csv", required: true },
  { id: "trajectory_structures", glob: "1_Trajectories/*/*.cif", required: false },
  { id: "refolded", glob: "2_Refolded/!_Refolded.csv", required: false },
  { id: "refolded_structures", glob: "2_Refolded/*.cif", required: false },
  { id: "ranked", glob: "3_Ranked/!_Ranked.csv", required: false },
  { id: "accepted_structures", glob: "3_Ranked/*.cif", required: false },
  { id: "upstream_summary", glob: "summary.csv", required: true },
  { id: "summary", glob: SUMMARY, required: false },
];
type Json = Record<string, unknown>;
interface Campaign extends Json { targets: Json[] }
const EXTENSIONS = [".pdb", ".cif", ".mmcif", ".fa", ".fasta"];
const KEYS = new Set(["targets", "modality", "binder_lengths", "binder_scaffold", "number_of_final_designs", "max_trajectories", "project_folder", "resume", "auto_multi_gpu", "design_workers", "campaign_seed"]);
const TARGET_KEYS = new Set(["name", "target_path", "chains", "hotspots", "coldspots", "objective", "weight"]);
function fail(message: string, code = "INVALID_RUN_INPUT"): never {
  throw new MoldeskError({ code, message, remediation: "Use examples/bindcraft2/campaign.json; provide explicit targets and positive finite design/trajectory bounds." });
}
function object(value: unknown): value is Json { return !!value && typeof value === "object" && !Array.isArray(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function parse(input: string): Campaign {
  if (path.extname(input).toLowerCase() !== ".json") fail("BindCraft2 requires a .json campaign.");
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(input, "utf8")); } catch { fail("BindCraft2 campaign is missing or invalid JSON."); }
  if (!object(raw) || !Array.isArray(raw.targets) || raw.targets.length === 0) fail("BindCraft2 requires a non-empty explicit targets list.");
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) fail(`Unsupported BindCraft2 campaign field: ${key}.`);
  const names = new Set<string>();
  for (const target of raw.targets) {
    if (!object(target)) fail("Each target must be an object.");
    for (const key of Object.keys(target)) if (!TARGET_KEYS.has(key)) fail(`Unsupported target field: ${key}.`);
    if (typeof target.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.name) || names.has(target.name)) fail("Target names must be unique safe identifiers.");
    names.add(target.name);
    if (typeof target.target_path !== "string" || !EXTENSIONS.includes(path.extname(target.target_path).toLowerCase())) fail("Each target needs a PDB/mmCIF/FASTA target_path.");
    for (const key of ["chains", "hotspots", "coldspots"]) if (target[key] !== undefined && (typeof target[key] !== "string" || !target[key])) fail(`Target ${key} must be a non-empty string.`);
    if (target.objective !== undefined && !["target", "detarget"].includes(String(target.objective))) fail("Unsupported target objective.");
    if (target.weight !== undefined && (typeof target.weight !== "number" || !Number.isFinite(target.weight) || target.weight <= 0)) fail("Target weight must be finite and positive.");
  }
  if (raw.binder_scaffold !== undefined && (typeof raw.binder_scaffold !== "string" || ![".pdb", ".cif", ".mmcif"].includes(path.extname(raw.binder_scaffold).toLowerCase()))) fail("binder_scaffold must reference a PDB/mmCIF file.");
  if (raw.project_folder !== undefined && typeof raw.project_folder !== "string") fail("project_folder must be a string; MoleculeDesk replaces it with run output.");
  if (raw.campaign_seed !== undefined && (typeof raw.campaign_seed !== "number" || !Number.isSafeInteger(raw.campaign_seed) || raw.campaign_seed < 0 || raw.campaign_seed > 0xffffffff)) fail("campaign_seed must be an integer in [0, 2^32-1].");
  if (raw.resume !== undefined && raw.resume !== false) fail("Resume is not supported; every MoleculeDesk campaign starts a fresh run.");
  if (raw.auto_multi_gpu !== undefined && raw.auto_multi_gpu !== false) fail("Automatic worker spawning is not supported.");
  if (raw.design_workers !== undefined && raw.design_workers !== 1) fail("Only one design worker is supported.");
  if (!raw.targets.some((t: Json) => t.objective !== "detarget")) fail("Campaign needs at least one positive target.");
  return raw as Campaign;
}
function refs(job: Campaign): CompanionInputRef[] {
  const result = job.targets.map((t, i) => ({ id: `target-${i}`, sourcePath: t.target_path as string }));
  if (job.binder_scaffold) result.push({ id: "scaffold", sourcePath: job.binder_scaffold as string });
  return result;
}
function checkReference(input: string, ref: CompanionInputRef): void {
  const root = fs.realpathSync(path.dirname(input));
  const requested = path.resolve(path.dirname(input), ref.sourcePath);
  if (ref.sourcePath.split(/[\\/]/).includes("..")) fail(`Traversal in companion: ${ref.id}.`);
  let file: string;
  try { file = fs.realpathSync(requested); } catch { fail(`Missing companion: ${ref.id}.`); }
  if (!file.startsWith(root + path.sep)) fail(`Companion escapes campaign directory: ${ref.id}.`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) fail(`Companion must be a non-empty regular file: ${ref.id}.`);
}
function bounded(job: Campaign, params: Json): Campaign {
  const resolved = structuredClone(job);
  for (const key of ["modality", "number_of_final_designs", "max_trajectories", "resume"]) if (params[key] !== undefined) resolved[key] = params[key];
  if (params.min_length !== undefined || params.max_length !== undefined) {
    if (params.min_length === undefined || params.max_length === undefined) fail("Pass both min_length and max_length.", "INVALID_RUN_PARAMS");
    resolved.binder_lengths = [params.min_length, params.max_length];
  }
  if (!positive(resolved.number_of_final_designs) || !positive(resolved.max_trajectories)) fail("number_of_final_designs and max_trajectories must be positive integers.", "INVALID_RUN_PARAMS");
  resolved.modality ??= "binder";
  if (typeof resolved.modality !== "string" || !MODALITIES.includes(resolved.modality)) fail("Unsupported modality or modality combination.", "INVALID_RUN_PARAMS");
  const scaffolded = ["VHH", "ARP"].includes(resolved.modality);
  if (scaffolded && (resolved.binder_lengths !== undefined || resolved.binder_scaffold !== undefined)) fail("VHH/ARP use their pinned shipped scaffold; omit custom scaffold and lengths.", "INVALID_RUN_PARAMS");
  if (!scaffolded && resolved.binder_scaffold && resolved.binder_lengths !== undefined) fail("Custom scaffold determines binder length; omit binder_lengths.", "INVALID_RUN_PARAMS");
  if (!scaffolded && !resolved.binder_scaffold) {
    const lengths = resolved.binder_lengths;
    if (!Array.isArray(lengths) || lengths.length !== 2 || !lengths.every(positive) || lengths[0] > lengths[1]) fail("binder_lengths must be an ordered positive integer pair.", "INVALID_RUN_PARAMS");
    if (["peptide", "cyclic_peptide"].includes(resolved.modality) && lengths[1] >= 25) fail("Peptide lengths must be below 25 residues.", "INVALID_RUN_PARAMS");
  }
  if (resolved.resume !== undefined && resolved.resume !== false) fail("Resume is not supported.", "INVALID_RUN_PARAMS");
  resolved.resume = false;
  resolved.auto_multi_gpu = false;
  resolved.design_workers = 1;
  return resolved;
}
function environment(modelDir: string, assetsDir: string, cache: string): Record<string, string> {
  return {
    PYTHONPATH: path.join(modelDir, "source"), PYTHONNOUSERSITE: "1",
    BINDCRAFT_AF2_PARAMS: path.join(assetsDir, "alphafold"),
    BINDCRAFT_MPNN_WEIGHTS: path.join(modelDir, "source/bindcraft/weights/proteinmpnn/weights_neutral"),
    BINDCRAFT_WEIGHTS: assetsDir, XDG_CACHE_HOME: cache,
    JAX_COMPILATION_CACHE_DIR: path.join(cache, "jax"), JAX_PLATFORMS: "cuda",
    MPLCONFIGDIR: path.join(cache, "matplotlib"), LD_LIBRARY_PATH: "",
  };
}
// Reset inherited upstream knobs before importing its CLI; neither worker identity
// nor an operator environment may bypass the bounded single-process campaign.
const CLEAN_ENV = `
import os
os.environ.pop('JAX_SKIP_CUDA_CONSTRAINTS_CHECK', None)
for key in tuple(os.environ):
    if key.startswith('BINDCRAFT_') and key not in ('BINDCRAFT_AF2_PARAMS', 'BINDCRAFT_MPNN_WEIGHTS', 'BINDCRAFT_WEIGHTS'):
        del os.environ[key]
`;
const CHECK_WEIGHTS = `
import hashlib, json, pathlib, zipfile
from bindcraft.model_weights import model_weights, missing_model_weights, alphafold_parameter_file
parameters, mpnn = model_weights(download=False)
assert not missing_model_weights(parameters, mpnn), missing_model_weights(parameters, mpnn)
for variant, expected in ${JSON.stringify(MPNN_HASHES)}.items():
    file = pathlib.Path(mpnn).parent / ('weights_' + variant) / 'v_48_020.npz'
    assert hashlib.sha256(file.read_bytes()).hexdigest() == expected, f'corrupt MPNN weights: {variant}'
for model, expected in ${JSON.stringify(AF_HASHES)}.items():
    file = pathlib.Path(alphafold_parameter_file(parameters, model))
    assert file.stat().st_size == expected['size'], f'wrong AlphaFold checkpoint size: {model}'
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    assert digest.hexdigest() == expected['sha256'], f'corrupt AlphaFold checkpoint: {model}'
    with zipfile.ZipFile(file) as checkpoint:
        assert checkpoint.namelist(), f'empty AlphaFold checkpoint: {model}'
`;
const GPU_PROBE = `
import jax
assert jax.default_backend() == 'gpu', 'BindCraft2 requires JAX CUDA; CPU fallback refused'
assert jax.devices() and all(d.platform == 'gpu' for d in jax.devices()), 'no CUDA devices'
assert float(jax.numpy.arange(4, dtype=jax.numpy.float32).sum().block_until_ready()) == 6.0
print('BindCraft2 JAX CUDA:', jax.devices(), flush=True)
`;
const LAUNCH = `${CLEAN_ENV}\n${CHECK_WEIGHTS}\n${GPU_PROBE}\nfrom bindcraft.cli import main\nmain()`;

// csv.DictReader handles upstream's quoted sequences/metadata without duplicating
// a CSV parser in TypeScript. Paths arrive via argv, never script interpolation.
const RESULT_PROBE = `
import csv, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1]).resolve()
campaign = json.loads((root / '${RESOLVED}').read_text())
assert isinstance(json.loads((root / 'campaign_metadata.json').read_text()), dict)
def table(file):
    assert file.resolve().is_relative_to(root.resolve()) and not any(p.is_symlink() for p in (file, *file.parents)), f'unsafe output: {file}'
    with file.open(newline='') as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames and len(set(reader.fieldnames)) == len(reader.fieldnames), f'invalid CSV: {file}'
        rows = list(reader)
        assert all(None not in row and all(v is not None for v in row.values()) for row in rows), f'malformed CSV: {file}'
        return reader.fieldnames, rows
fields, trajectories = table(root / '1_Trajectories/!_Trajectories.csv')
assert 'design' in fields and 'trajectory' in fields and trajectories, 'no completed trajectories'
_, rows = table(root / 'summary.csv')
counts = {r['metric']: float(r['mean']) for r in rows if r.get('scope') == 'campaign' and r.get('metric') in ('trajectories', 'accepted_designs')}
attempted, accepted = counts['trajectories'], counts['accepted_designs']
assert attempted.is_integer() and accepted.is_integer() and attempted > 0 and accepted >= 0, 'invalid campaign counts'
assert attempted <= campaign['max_trajectories'], 'trajectory budget exceeded'
assert attempted >= len(trajectories), 'inconsistent trajectory summary'
ranked = root / '3_Ranked/!_Ranked.csv'
if ranked.is_file():
    fields, ranks = table(ranked)
    assert 'design' in fields and 'rank' in fields, 'invalid ranked table'
    assert len(ranks) == accepted, 'inconsistent accepted count'
    assert [int(row['rank']) for row in ranks] == list(range(1, len(ranks) + 1)), 'invalid ranks'
    assert len({row['design'] for row in ranks}) == len(ranks), 'duplicate accepted designs'
    for row in ranks:
        design = row['design']
        assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', design), 'unsafe design name'
        files = list(ranked.parent.glob(design + '.cif')) + list(ranked.parent.glob(design + '_*.cif'))
        assert any(f.name not in (design + '_monomer.cif',) and not f.is_symlink() and f.is_file() for f in files), f'missing accepted structure: {design}'
else:
    assert accepted == 0, 'accepted designs missing ranked table'
assert accepted >= campaign['number_of_final_designs'] or attempted == campaign['max_trajectories'], 'campaign stopped before its budget or goal'
refolded = root / '2_Refolded/!_Refolded.csv'
if refolded.is_file(): table(refolded)
for filename in sys.argv[2:]:
    from biotite.structure.io import pdbx
    import numpy as np
    structure = pdbx.get_structure(pdbx.CIFFile.read(filename), model=1)
    assert len(structure) > 0 and np.isfinite(structure.coord).all(), f'invalid structure: {filename}'
print(json.dumps({'attempted': int(attempted), 'accepted': int(accepted), 'requested': campaign['number_of_final_designs'], 'budget': campaign['max_trajectories'], 'budgetExhausted': attempted == campaign['max_trajectories'], 'goalReached': accepted >= campaign['number_of_final_designs']}))
`;

export const bindcraft2Adapter: ModelAdapterDefinition = {
  modelName: "bindcraft2",
  params: [
    { name: "modality", type: "string", enum: MODALITIES, description: "Binder format" },
    { name: "number_of_final_designs", type: "number", min: 1, description: "Requested accepted designs" },
    { name: "max_trajectories", type: "number", min: 1, description: "Required finite attempt budget" },
    { name: "min_length", type: "number", min: 1 }, { name: "max_length", type: "number", min: 1 },
    { name: "resume", type: "boolean", description: "Only false supported; each run is fresh" },
  ],
  async validateInput(inputPath) {
    const job = parse(inputPath);
    for (const ref of refs(job)) checkReference(inputPath, ref);
  },
  async resolveCompanionInputs(inputPath) { return refs(parse(inputPath)); },
  async installPlan() { return { steps: [{ id: "dependencies", description: "Install pinned BindCraft2 and CUDA/JAX dependencies" }, { id: "assets", description: "Verify managed AlphaFold and shipped MPNN weights" }, { id: "verify", description: "Check presets, CLI, weights and real JAX CUDA operation" }] }; },
  async command(context: RunContext) {
    if (context.platform !== "linux-x64") fail("BindCraft2 requires the Linux x64 CUDA installation.", "INVALID_RUN_PARAMS");
    const job = bounded(parse(context.inputPath), context.params);
    const staged = new Map(context.companionInputs?.map((r) => [r.id, r.path]));
    for (const ref of refs(job)) {
      const file = staged.get(ref.id);
      const inputRoot = fs.realpathSync(path.dirname(context.inputPath));
      if (!file || !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || !fs.realpathSync(file).startsWith(inputRoot + path.sep)) fail(`Missing or unsafe staged companion: ${ref.id}.`);
      if (ref.id === "scaffold") job.binder_scaffold = file;
      else job.targets[Number(ref.id.slice(7))]!.target_path = file;
    }
    job.project_folder = context.outputDir;
    const campaignPath = path.join(context.outputDir, RESOLVED);
    fs.writeFileSync(campaignPath, `${JSON.stringify(job, null, 2)}\n`, { flag: "wx" });
    // Keep working caches beside output, not in collected scientific results.
    const cache = path.join(path.dirname(context.outputDir), "cache");
    return { executable: context.runtimeExecutable, args: ["-c", LAUNCH, "design", campaignPath], env: environment(context.modelDir, context.assetsDir, cache) };
  },
  async collectOutputs(context) {
    const collected = collectGlobOutputs(context.outputDir, OUTPUTS);
    const structures = collected.filter((o) => o.id.endsWith("structures"));
    for (const output of structures) {
      const text = fs.readFileSync(output.path, "utf8");
      if (!/^data_\S+/m.test(text) || !text.includes("_atom_site.")) fail(`Invalid mmCIF output: ${output.path}.`, "INVALID_RUN_OUTPUT");
    }
    const result = await (context.runner ?? runCommand)(context.runtimeExecutable, ["-c", RESULT_PROBE, context.outputDir, ...structures.map((s) => s.path)], {
      cwd: context.outputDir, timeoutMs: 60_000,
      env: { ...process.env, ...environment(context.modelDir, context.assetsDir, path.join(path.dirname(context.outputDir), "cache")) },
    });
    if (result.code !== 0) fail(`Invalid BindCraft2 campaign results: ${result.stderr.slice(-1000)}.`, "INVALID_RUN_OUTPUT");
    let summary: { accepted: number };
    try { summary = JSON.parse(result.stdout); } catch { fail("BindCraft2 result parser returned invalid JSON.", "INVALID_RUN_OUTPUT"); }
    if (!object(summary) || !Number.isSafeInteger(summary.accepted) || summary.accepted < 0) fail("Invalid accepted design count.", "INVALID_RUN_OUTPUT");
    if (summary.accepted > 0 && !collected.some((o) => o.id === "accepted_structures")) fail("Accepted designs have no structures.", "INVALID_RUN_OUTPUT");
    fs.writeFileSync(path.join(context.outputDir, SUMMARY), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
    return collectGlobOutputs(context.outputDir, OUTPUTS);
  },
  async verifyInstallation(context: InstallContext) {
    if (context.platform !== "linux-x64") return { passed: false, output: "BindCraft2 supports Linux x64/NVIDIA only." };
    const source = path.join(context.modelDir, "source");
    const python = path.join(context.modelDir, ".venv/bin/python");
    const required = [python, path.join(context.modelDir, ".venv/bin/bindcraft"), path.join(source, "settings/core/default.json"),
      ...AF_MODELS.map((model) => path.join(context.assetsDir, "alphafold", `params_${model}.npz`)),
      ...Object.keys(MPNN_HASHES).map((variant) => path.join(source, "bindcraft/weights/proteinmpnn", `weights_${variant}`, "v_48_020.npz"))];
    // Managed venv interpreters can be symlinks to uv's managed Python.
    for (const file of required) if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { passed: false, output: `Missing installation file: ${file}` };
    const script = `${CLEAN_ENV}\nimport importlib.metadata, shutil, subprocess, sys\nassert importlib.metadata.version('bindcraft') == '1.0.3'\nassert importlib.metadata.version('jax') == '0.11.2'\nassert shutil.disk_usage(${JSON.stringify(context.modelDir)}).free >= 2 * 1024**3, 'at least 2 GiB free required for campaign results'\n${CHECK_WEIGHTS}\n${GPU_PROBE}\nsubprocess.run([sys.executable, '-m', 'bindcraft.selfcheck', 'cuda12'], check=True)\nsubprocess.run([sys.executable, '-m', 'bindcraft.cli', 'design', '--help'], check=True)`;
    const result = await (context.runner ?? runCommand)(python, ["-c", script], { cwd: source, env: { ...process.env, ...environment(context.modelDir, context.assetsDir, path.join(context.modelDir, "cache")) }, timeoutMs: 300_000 });
    return { passed: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
  },
};
