import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateParams, type ModelAdapterDefinition, type ResolveParamDefaultsContext, type RunContext } from "@moldesk/adapters";
import type { ModelManifestV1, RuntimeKind } from "@moldesk/registry";
import {
  getSystemReport,
  runDir,
  stageCompanionInputs,
  type MoldeskPaths,
  type SystemReport,
} from "@moldesk/runtime";
import { MoldeskError } from "./errors.js";
import { digest, sha256File } from "./hash.js";
import { generateRunReport } from "./run-report.js";
import type { RunModelResult, RunRecord } from "./run.js";
import { VERSION } from "./version.js";

export function toErrorInfo(error: unknown, fallbackCode: string): { code: string; message: string } {
  if (error instanceof MoldeskError) return { code: error.code, message: error.message };
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

export function writeRunRecord(runDirPath: string, record: RunRecord): void {
  const file = path.join(runDirPath, "run.json");
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export interface PreparedRunParams {
  suppliedParams: Record<string, string>;
  effectiveParams: Record<string, unknown>;
}

/**
 * Step 3 shared by local and cloud runs: applies platform-dependent adapter defaults (an explicit
 * `--param` always wins), then validates. Rejects with INVALID_RUN_PARAMS before any run directory exists.
 */
export function prepareRunParams(
  adapter: ModelAdapterDefinition,
  manifestName: string,
  installed: ResolveParamDefaultsContext["installed"],
  params: Record<string, string> | undefined,
): PreparedRunParams {
  // Platform-dependent defaults (e.g. Boltz's `accelerator`) come from the adapter,
  // not a static `ParamDescriptor.default`, since the right value depends on which
  // platform-specific runtime entry was actually installed. Pre-seed `supplied` with
  // them (as strings, since `validateParams` coerces from `--param` strings) for any
  // key the caller didn't explicitly pass — an explicit `--param` always wins.
  const dynamicDefaults = adapter.resolveParamDefaults?.({ manifestName, installed }) ?? {};
  const suppliedParams = { ...(params ?? {}) };
  for (const [key, value] of Object.entries(dynamicDefaults)) {
    if (suppliedParams[key] === undefined) suppliedParams[key] = String(value);
  }
  const { effective, errors } = validateParams(adapter.params ?? [], suppliedParams);
  if (errors.length > 0) {
    throw new MoldeskError({
      code: "INVALID_RUN_PARAMS",
      message: errors.join("; "),
      remediation: "Fix the listed --param values and retry.",
      details: { errors },
    });
  }
  return { suppliedParams, effectiveParams: effective };
}

export interface RunDirectories {
  runId: string;
  runDirPath: string;
  inputDir: string;
  outputDir: string;
}

/** Allocates the run ID and its `input/` and `output/` directories. */
export function allocateRunDirectory(paths: MoldeskPaths): RunDirectories {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const runDirPath = runDir(runId, { MOLDESK_HOME: paths.home });
  const inputDir = path.join(runDirPath, "input");
  const outputDir = path.join(runDirPath, "output");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  return { runId, runDirPath, inputDir, outputDir };
}

export interface CreateRunSnapshotParams {
  dirs: RunDirectories;
  manifest: ModelManifestV1;
  adapter: ModelAdapterDefinition;
  runtime: RuntimeKind;
  installationFingerprint: string;
  resolvedInputPath: string;
  suppliedParams: Record<string, unknown>;
  effectiveParams: Record<string, unknown>;
  signal?: AbortSignal;
}

export type RunSnapshot =
  | {
      ok: true;
      record: RunRecord;
      startedAt: string;
      storedInputPath: string;
      companionInputs: Array<{ id: string; path: string }>;
    }
  /** Snapshotting failed after the run directory was allocated; `record` is already finalized on disk. */
  | { ok: false; record: RunRecord };

/**
 * Copies and hashes the job input (and declared companion inputs), captures hardware, and writes
 * the initial `preparing` record. A failure here finalizes `run.json` as failed/cancelled instead
 * of rejecting, since the run directory already exists.
 */
export async function createRunSnapshot(params: CreateRunSnapshotParams): Promise<RunSnapshot> {
  const { dirs, manifest, adapter, resolvedInputPath } = params;
  const inputRecords: RunRecord["input"] = [];
  let hardware: SystemReport | undefined;

  const buildRecord = (system: SystemReport, startedAt: string): RunRecord => ({
    schemaVersion: 1,
    id: dirs.runId,
    status: "preparing",
    model: manifest.name,
    modelVersion: manifest.modelVersion,
    adapterVersion: manifest.adapterVersion,
    moldeskVersion: VERSION,
    runtime: params.runtime,
    installationFingerprint: params.installationFingerprint,
    manifestSha256: digest(manifest),
    hardware: system,
    input: inputRecords,
    parameters: { supplied: params.suppliedParams, effective: params.effectiveParams },
    command: { executable: "", args: [], cwd: dirs.runDirPath },
    startedAt,
    outputs: [],
    logs: { stdout: path.join(dirs.runDirPath, "stdout.log"), stderr: path.join(dirs.runDirPath, "stderr.log") },
  });

  try {
    hardware = await getSystemReport();

    // --- Step 5: copy/snapshot the original input. ---
    const storedInputPath = path.join(dirs.inputDir, path.basename(resolvedInputPath));
    fs.copyFileSync(resolvedInputPath, storedInputPath);
    const inputSha256 = await sha256File(storedInputPath);
    inputRecords.push({ originalPath: resolvedInputPath, storedPath: storedInputPath, sha256: inputSha256, role: "job" });

    // Models whose job file references separate companion files (e.g. DiffDock-L's
    // protein PDB + ligand file) declare them via `resolveCompanionInputs`, given the
    // *original* (pre-copy) resolved job path so relative references resolve against
    // where the job file actually lives. Absent means unchanged single-file behavior.
    const companionRefs = await adapter.resolveCompanionInputs?.(resolvedInputPath) ?? [];
    const stagedCompanions = companionRefs.length > 0
      ? stageCompanionInputs({ jobFilePath: resolvedInputPath, refs: companionRefs, inputDir: dirs.inputDir })
      : [];
    for (const staged of stagedCompanions) {
      inputRecords.push({
        originalPath: staged.originalPath,
        storedPath: staged.storedPath,
        sha256: await sha256File(staged.storedPath),
        role: staged.id,
      });
    }
    const companionInputs = stagedCompanions.map((staged) => ({ id: staged.id, path: staged.storedPath }));

    const startedAt = new Date().toISOString();
    const record = buildRecord(hardware, startedAt);

    // --- Step 6: write the initial record. From this point, every path below finalizes run.json. ---
    writeRunRecord(dirs.runDirPath, record);
    return { ok: true, record, startedAt, storedInputPath, companionInputs };
  } catch (error) {
    // If hardware capture itself failed, retry once; a second failure leaves no record to finalize
    // and propagates (no fabricated hardware report).
    hardware ??= await getSystemReport();
    const startedAt = new Date().toISOString();
    const record = buildRecord(hardware, startedAt);
    record.status = params.signal?.aborted ? "cancelled" : "failed";
    record.error = toErrorInfo(error, "RUN_SNAPSHOT_FAILED");
    const finishedAt = new Date().toISOString();
    record.finishedAt = finishedAt;
    record.durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    writeRunRecord(dirs.runDirPath, record);
    return { ok: false, record };
  }
}

/** Checksums and sizes the adapter's collected outputs (spec step 12). */
export async function collectRunOutputs(
  adapter: ModelAdapterDefinition,
  context: RunContext,
): Promise<RunRecord["outputs"]> {
  const collected = await adapter.collectOutputs(context);
  return Promise.all(
    collected.map(async (output) => ({
      id: output.id,
      path: output.path,
      sha256: await sha256File(output.path),
      sizeBytes: fs.statSync(output.path).size,
    })),
  );
}

export interface FinalizeRunParams {
  adapter: ModelAdapterDefinition;
  context: RunContext;
  runDirPath: string;
  record: RunRecord;
  startedAt: string;
  signal?: AbortSignal;
  /** Create the offline report for a succeeded run. Default true. */
  visualize?: boolean;
  /** Copy outputs here after a succeeded run; never changes the run's own status. */
  outputDir?: string;
}

/** Derived report, final atomic `run.json` write, and the post-finalization `--output` copy. */
export async function finalizeRun(params: FinalizeRunParams): Promise<RunModelResult> {
  const { adapter, context, runDirPath, record, startedAt, signal, visualize, outputDir } = params;

  // --- Derived report. Deliberately outside the execution try/catch: describing or exporting a
  // report can only ever add a warning, never change the model's outcome or error. ---
  if (record.status === "succeeded" && visualize !== false) {
    const report = await generateRunReport({ adapter, context, runDirPath, record, signal });
    if (report.artifact) record.artifacts = [report.artifact];
    if (report.warning) record.warnings = [...(record.warnings ?? []), report.warning];
  }

  // --- Step 13: write the final record atomically. ---
  const finishedAt = new Date().toISOString();
  record.finishedAt = finishedAt;
  record.durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  writeRunRecord(runDirPath, record);

  const result: RunModelResult = { status: record.status as RunModelResult["status"], record };

  // --- --output: a distinct, post-finalization copy step; never changes the run's own status. ---
  if (result.status === "succeeded" && outputDir) {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      for (const output of record.outputs) {
        const target = path.join(outputDir, path.basename(output.path));
        fs.copyFileSync(output.path, target, fs.constants.COPYFILE_EXCL);
      }
      // The report is self-contained; copy it under a name that cannot collide with outputs.
      for (const artifact of record.artifacts ?? []) {
        fs.copyFileSync(artifact.path, path.join(outputDir, `moldesk-report-${record.id}.html`), fs.constants.COPYFILE_EXCL);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.exportError = { code: "OUTPUT_COLLISION", message };
    }
  }

  return result;
}
