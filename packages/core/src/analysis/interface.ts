import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMoldeskPaths, runCommand, type MoldeskPaths, type RunOptions, type RunResult } from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import type { RunRecord } from "../run.js";
import { VERSION } from "../version.js";
import { requireIpsae } from "../tools/ipsae.js";
import { hashArtifact, verifyArtifact, artifactMismatch, resolveBoltzPredictionArtifacts, type HashedFile } from "./boltz-artifacts.js";
import { mapBoltzProteinTokens } from "./interface-mapping.js";
import { parseIpsaeOutput, type InterfaceScores } from "./ipsae-output.js";
import { readStructureInput, readTextInput } from "./structure-input.js";
import type { AnalysisEnvelope } from "../schemas/envelope.js";
import { writeFileExclusive } from "@moldesk/visualizer";

export interface InterfaceScoreResult {
  inputs: { structure: HashedFile; pae: HashedFile; confidence: HashedFile; plddt?: HashedFile };
  chains: { target: { authId: string; labelId: string }; binder: { authId: string; labelId: string } };
  settings: { paeCutoffAngstrom: number; distanceCutoffAngstrom: number };
  tokenMapping: { mode: "boltz-two-protein-chains"; count: number; sha256: string };
  scores: InterfaceScores;
  scorer: { name: "ipsae"; revision: string; sourceSha256: string };
  artifacts: HashedFile[];
}
export interface InterfaceScoreOptions {
  structure: string; pae: string; confidence: string; plddt?: string;
  targetChain: string; binderChain: string;
  paeCutoffAngstrom?: number; distanceCutoffAngstrom?: number;
  /** When supplied, binds every selected sidecar to an unchanged successful run. */
  runRecord?: RunRecord;
  outputPath?: string; paths?: MoldeskPaths; signal?: AbortSignal; timeoutMs?: number;
  runner?: (command: string, args: string[], options: RunOptions) => Promise<RunResult>;
}
function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new MoldeskError({ code, message, remediation: "Check prediction inputs, tool installation and scoring artifacts.", details });
}

/** CPU-only, offline evaluation. Never installs a tool or executes the generated PyMOL script. */
export async function scoreProteinInterface(options: InterfaceScoreOptions): Promise<AnalysisEnvelope<InterfaceScoreResult>> {
  const pae = options.paeCutoffAngstrom ?? 15, distance = options.distanceCutoffAngstrom ?? 15;
  if (![pae, distance].every((v) => Number.isSafeInteger(v) && v > 0) || !options.targetChain || !options.binderChain || options.targetChain === options.binderChain ||
      (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))) fail("INVALID_INTERFACE_ARGS", "Distinct chain roles, positive integer cutoffs and a positive timeout are required.");
  if (options.signal?.aborted) fail("INTERFACE_CANCELLED", "Interface evaluation cancelled.");
  if (options.outputPath && fs.existsSync(options.outputPath)) fail("OUTPUT_EXISTS", `File exists: ${options.outputPath}`);
  const tool = await requireIpsae(options.paths);
  const structure = await hashArtifact(options.structure, 32 * 1024 ** 2);
  const stem = path.basename(structure.path, path.extname(structure.path));
  if (!/^(.*)_model_\d+$/.test(stem)) artifactMismatch("Expected a Boltz prediction filename ending _model_<rank>.cif.");
  const sidecar = async (file: string, prefix: string, ext: string, cap: number) => {
    if (path.dirname(path.resolve(file)) !== path.dirname(structure.path) || path.basename(file) !== `${prefix}_${stem}${ext}`) artifactMismatch(`${prefix} must be the exact sidecar of ${structure.path}.`);
    return hashArtifact(file, cap);
  };
  const inputs = { structure, pae: await sidecar(options.pae, "pae", ".npz", 34 * 1024 ** 2),
    confidence: await sidecar(options.confidence, "confidence", ".json", 1024 ** 2),
    ...(options.plddt ? { plddt: await sidecar(options.plddt, "plddt", ".npz", 34 * 1024 ** 2) } : {}) };
  if (options.runRecord) {
    const suffix = /^(.*)_model_(\d+)$/.exec(stem)!;
    const recorded = await resolveBoltzPredictionArtifacts(options.runRecord, { recordId: suffix[1], predictionRank: Number(suffix[2]) });
    for (const [key, file] of Object.entries(inputs)) {
      const expected = recorded[key as "structure" | "pae" | "confidence" | "plddt"];
      if (!expected || expected.sha256 !== file.sha256 || expected.sizeBytes !== file.sizeBytes) artifactMismatch(`Selected ${key} differs from its run record.`);
    }
  }
  const input = readStructureInput(structure.path);
  if (input.sha256 !== structure.sha256) artifactMismatch("Structure changed during validation.");
  const mapping = await mapBoltzProteinTokens(input, options.targetChain, options.binderChain);
  const confidenceInput = readTextInput(inputs.confidence.path, "Boltz confidence", 1024 ** 2);
  if (confidenceInput.sha256 !== inputs.confidence.sha256) artifactMismatch("Confidence changed during validation.");
  let confidence;
  try { confidence = JSON.parse(confidenceInput.text); }
  catch { artifactMismatch("Invalid confidence JSON."); }
  const pairs = confidence?.pair_chains_iptm;
  if (!pairs || Object.keys(pairs).sort().join() !== "0,1" || ["0", "1"].some((i) =>
    !pairs[i] || Object.keys(pairs[i]).sort().join() !== "0,1" || ["0", "1"].some((j) => typeof pairs[i][j] !== "number" || !Number.isFinite(pairs[i][j]) || pairs[i][j] < 0 || pairs[i][j] > 1))) artifactMismatch("Confidence chain indices must match the two Boltz chains (0,1).");
  const paths = options.paths ?? getMoldeskPaths();
  const cwd = options.outputPath ? `${path.resolve(options.outputPath)}.artifacts` : path.join(paths.runs, "interfaces", randomUUID());
  fs.mkdirSync(path.dirname(cwd), { recursive: true });
  try { fs.mkdirSync(cwd, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("OUTPUT_EXISTS", `Scoring artifacts exist: ${cwd}`); throw error; }
  const checked = async (script: string, args: string[]) => {
    const result = await (options.runner ?? runCommand)(tool.executable, ["-I", "-B", path.join(tool.dir, script), ...args], {
      cwd, env: { PATH: process.env.PATH ?? "", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", VECLIB_MAXIMUM_THREADS: "1" },
      timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal, maxOutputBytes: 1024 ** 2,
    });
    fs.writeFileSync(path.join(cwd, `${script}.stdout.log`), result.stdout, { mode: 0o600 });
    fs.writeFileSync(path.join(cwd, `${script}.stderr.log`), result.stderr, { mode: 0o600 });
    if (options.signal?.aborted || result.cancelled) fail("INTERFACE_CANCELLED", "Interface evaluation cancelled.", { artifacts: cwd });
    if (result.outputLimitExceeded || result.timedOut) fail("IPSAE_EXECUTION_FAILED", "ipSAE exceeded its time/output limit.", { artifacts: cwd });
    if (result.code !== 0) fail(script === "validate.py" && result.code === 2 ? (result.stderr.includes("PAE_STRUCTURE_MISMATCH") ? "PAE_STRUCTURE_MISMATCH" : "INVALID_PAE") : "IPSAE_EXECUTION_FAILED", result.stderr.slice(-4000) || `ipSAE exited ${result.code}.`, { artifacts: cwd });
  };
  // Snapshot first, then verify both source and snapshot hashes; validation/scoring read only snapshots.
  for (const [key, file] of Object.entries(inputs)) {
    const dest = path.join(cwd, key === "structure" ? "original.cif" : `${key}_prediction${key === "confidence" ? ".json" : ".npz"}`);
    fs.copyFileSync(file.path, dest, fs.constants.COPYFILE_EXCL);
    if ((await hashArtifact(dest)).sha256 !== file.sha256) artifactMismatch("Artifact changed while snapshotting.");
    await verifyArtifact(file);
  }
  fs.writeFileSync(path.join(cwd, "prediction.cif"), mapping.canonicalCif);
  fs.writeFileSync(path.join(cwd, "token-mapping.json"), JSON.stringify({ tokens: mapping.tokens, chains: mapping.chains, aliases: { target: mapping.targetAlias, binder: mapping.binderAlias } }));
  await checked("validate.py", [String(mapping.tokenMapping.count)]);
  await checked("ipsae.py", ["pae_prediction.npz", "prediction.cif", String(pae), String(distance)]);
  const table = path.join(cwd, `prediction_${String(pae).padStart(2, "0")}_${String(distance).padStart(2, "0")}.txt`);
  if (!fs.existsSync(table) || fs.statSync(table).size > 1024 ** 2) fail("IPSAE_NO_RESULT", "Missing/oversized ipSAE result table.", { artifacts: cwd });
  const scores = parseIpsaeOutput(fs.readFileSync(table, "utf8"), mapping.targetAlias, mapping.binderAlias, pae, distance);
  const artifacts: HashedFile[] = [];
  for (const file of fs.readdirSync(cwd).sort()) {
    const full = path.join(cwd, file);
    // Empty diagnostic logs are valid; scientific artifacts are never empty.
    if (fs.statSync(full).size > 0) artifacts.push(await hashArtifact(full));
  }
  const envelope: AnalysisEnvelope<InterfaceScoreResult> = {
    schemaVersion: 1, kind: "moldesk.interface", status: "ok", result: {
      inputs, chains: mapping.chains, settings: { paeCutoffAngstrom: pae, distanceCutoffAngstrom: distance }, tokenMapping: mapping.tokenMapping, scores,
      scorer: { name: "ipsae", revision: tool.receipt.revision, sourceSha256: tool.receipt.sourceSha256 }, artifacts,
    }, warnings: [{ code: "MODELED_INTERFACE", message: "ipSAE assesses a modeled interface, not measured affinity. Raw ancillary columns are unvalidated and are not published as metrics." }],
    provenance: { moldeskVersion: VERSION, tool: { name: "ipsae", version: tool.receipt.revision } },
  };
  if (options.outputPath) await writeFileExclusive(options.outputPath, `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
  return envelope;
}
