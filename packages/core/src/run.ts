import path from "node:path";
import { getAdapter, type RunContext } from "@moldesk/adapters";
import { listAvailableModels, type RuntimeKind } from "@moldesk/registry";
import {
  getMoldeskPaths,
  redactEnv,
  PythonRuntimeProvider,
  type MoldeskPaths,
  type RuntimeProvider,
  type SystemReport,
} from "@moldesk/runtime";
import type { CloudRunDeps, CloudRunOptions } from "./cloud/run.js";
import { MoldeskError } from "./errors.js";
import { listInstalledModels } from "./install-state.js";
import { allocateRunDirectory, collectRunOutputs, createRunSnapshot, finalizeRun, prepareRunParams, toErrorInfo, writeRunRecord } from "./run-lifecycle.js";
import type { RunArtifact, RunWarning } from "./run-report.js";

/**
 * `runModel` only rejects for usage errors discovered before a run directory
 * is allocated (unknown model, not installed, invalid input/params — spec
 * §4.2 steps 1-3). From the moment a run directory exists (step 4 onward),
 * every outcome — success, nonzero exit, missing output, cancellation, or an
 * unexpected internal failure — resolves as a typed `RunModelResult` with a
 * finalized `run.json`, never a rejection. The CLI distinguishes the two by
 * catch (usage error, mapped via `MoldeskError.code`) vs. `result.status`.
 */
export interface RunModelOptions {
  paths?: MoldeskPaths;
  runtime?: RuntimeKind;
  /** Raw `--param key=value` strings, validated against the adapter's declared params. */
  params?: Record<string, string>;
  /** Copy declared outputs here after a successful run. Refuses to overwrite existing files. */
  outputDir?: string;
  /** CLI-constructed abort signal (SIGINT/SIGTERM) for graceful cancellation. */
  signal?: AbortSignal;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Injected for testability; defaults to a real `PythonRuntimeProvider`. */
  runtimeProvider?: RuntimeProvider;
  /** Create the offline molecular report for a successful run when the adapter describes one. Default true. */
  visualize?: boolean;
  /** `"local"` (default) runs on this machine; `"runpod"` runs on rented compute and requires `cloud`. */
  compute?: "local" | "runpod";
  /** Approved quote and limits for a remote run. Rejected for local runs. */
  cloud?: CloudRunOptions;
  /** Injected for tests; defaults to the production Runpod wiring. */
  cloudDeps?: CloudRunDeps;
  onProgress?: (event: { stage: string; message?: string }) => void;
}

export interface RunRecord {
  schemaVersion: 1;
  id: string;
  status: "preparing" | "running" | "succeeded" | "failed" | "cancelled";
  model: string;
  modelVersion: string;
  adapterVersion: string;
  moldeskVersion: string;
  runtime: RuntimeKind;
  installationFingerprint: string;
  manifestSha256: string;
  hardware: SystemReport;
  /** `role` is `"job"` for the primary submitted input and the companion's
   * declared `id` for anything staged via `resolveCompanionInputs`/
   * `stageCompanionInputs`. Optional/additive so existing single-input records
   * (every entry implicitly the primary input) remain valid. */
  input: Array<{ originalPath: string; storedPath: string; sha256: string; role?: string }>;
  parameters: { supplied: Record<string, unknown>; effective: Record<string, unknown> };
  command: { executable: string; args: string[]; cwd: string; env?: Record<string, string> };
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  process?: { pid?: number; exitCode?: number; signal?: string };
  outputs: Array<{ id: string; path: string; sha256: string; sizeBytes: number }>;
  logs: { stdout: string; stderr: string };
  error?: { code: string; message: string };
  /** Derived files (not scientific outputs). Updating one later does not rewrite this record. */
  artifacts?: RunArtifact[];
  /** Nonfatal problems, e.g. the report could not be created. They never change `status`. */
  warnings?: RunWarning[];
  /** Present only for remote runs. `hardware` above stays the local client's; the machine that ran inference is here. */
  compute?: RunCompute;
}

export interface RunCompute {
  provider: string;
  cachePolicy: "ephemeral" | "persistent";
  quoteId: string;
  /** Last pipeline stage reached, e.g. "running" or "collecting". */
  stage: string;
  datacenterId: string;
  gpuId: string;
  /** Provider resource IDs that were created for this run (pods and volumes). */
  resources: Array<{ role: "cpu" | "gpu" | "volume"; providerId: string }>;
  /** What actually ran inference, reported by the worker. */
  hardware?: { name: string; memoryMb?: number; driverVersion?: string; cudaVersion?: string };
  /** POSIX command and cwd on the worker; `record.command.cwd` stays the local run directory. */
  remoteCommand?: { executable: string; args: string[]; cwd: string };
  pythonVersion?: string;
  dependencyFreeze?: string[];
  sourceRevision?: string;
  cleanup: "confirmed" | "pending";
  workerLogCursor?: number;
  /** `complete: false` means the worker evicted log chunks before they could be fetched (bounded tail). */
  logs?: { complete: boolean; lostChunks: number };
}

export type { RunArtifact, RunWarning };

export interface RunModelResult {
  status: "succeeded" | "failed" | "cancelled";
  record: RunRecord;
  /** Set only if `--output` copy failed after an otherwise-succeeded run; see the module doc. */
  exportError?: { code: string; message: string };
  /** Remote runs only: paid resources could not be confirmed deleted. The scientific result is still valid. */
  cleanupPending?: { code: "CLOUD_CLEANUP_PENDING"; resources: Array<{ role: "cpu" | "gpu" | "volume"; providerId: string }> };
}

function runFailure(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

export async function runModel(
  modelName: string,
  inputPath: string,
  options: RunModelOptions = {},
): Promise<RunModelResult> {
  const paths = options.paths ?? getMoldeskPaths();

  // --- Remote execution is dispatched before any local installation lookup: it never needs one. ---
  if (options.compute === "runpod") {
    if (!options.cloud) {
      throw runFailure("CLOUD_OPTIONS_REQUIRED", "Cloud execution needs an approved quote.", "Pass --cache-policy, --max-budget and --max-lifetime and approve the quote.");
    }
    if (options.runtime === "docker") {
      throw runFailure("CLOUD_RUNTIME_UNSUPPORTED", "The docker runtime is not supported for cloud execution.", "Use the python runtime.");
    }
    const { runCloudModel } = await import("./cloud/run.js");
    const { createRunpodCloudDeps } = await import("./cloud/deps.js");
    const deps = options.cloudDeps ?? (await createRunpodCloudDeps({ paths }));
    return runCloudModel(
      modelName,
      inputPath,
      {
        params: options.params,
        outputDir: options.outputDir,
        signal: options.signal,
        onLog: options.onLog,
        visualize: options.visualize,
        cloud: options.cloud,
        onProgress: options.onProgress,
      },
      { ...deps, paths },
    );
  }
  if (options.cloud || options.cloudDeps) {
    throw runFailure("CLOUD_OPTIONS_WITHOUT_CLOUD", "Cloud options were given for a local run.", "Add --compute runpod, or remove the cloud options.");
  }

  // --- Step 1: load and validate manifest. No run directory yet: a failure here rejects. ---
  const manifest = listAvailableModels().find((entry) => entry.name === modelName);
  if (!manifest) {
    throw runFailure("UNKNOWN_MODEL", `Unknown model "${modelName}".`, "Run `moldesk list` to see available models.");
  }

  // --- Step 2: resolve a ready installation. ---
  const allInstalled = listInstalledModels(paths).filter((record) => record.model === modelName);
  const candidates = options.runtime ? allInstalled.filter((record) => record.runtime.kind === options.runtime) : allInstalled;
  if (candidates.length === 0) {
    throw runFailure(
      "MODEL_NOT_INSTALLED",
      options.runtime
        ? `${modelName} is not installed for the "${options.runtime}" runtime.`
        : `${modelName} is not installed.`,
      `Run \`moldesk install ${modelName}\`.`,
    );
  }
  if (!options.runtime && candidates.length > 1) {
    throw runFailure(
      "RUN_RUNTIME_SELECTION_REQUIRED",
      `${modelName} has ${candidates.length} installed runtime variants.`,
      "Pass --runtime python|docker to select one.",
    );
  }
  const installed = candidates[0];
  if (installed.runtime.kind !== "python" || !installed.runtime.python) {
    throw runFailure(
      "RUNTIME_EXECUTION_UNSUPPORTED",
      `Running ${modelName} via the "${installed.runtime.kind}" runtime is not yet supported.`,
      "Install and run a Python-runtime variant of this model instead.",
    );
  }

  // --- Step 3: validate input and params. Still no run directory: failures here reject. ---
  const adapter = getAdapter(modelName);
  if (!adapter) {
    throw runFailure("ADAPTER_NOT_FOUND", `No adapter is registered for ${modelName}.`, "Repair the registry installation.");
  }
  const resolvedInputPath = path.resolve(inputPath);
  await adapter.validateInput(resolvedInputPath);

  const { effectiveParams } = prepareRunParams(adapter, manifest.name, { runtime: installed.runtime }, options.params);

  // --- Step 4: allocate run ID and directory. From here on, every outcome resolves. ---
  const dirs = allocateRunDirectory(paths);
  const { runDirPath, outputDir } = dirs;

  // --- Steps 5-6: snapshot inputs and write the initial record. ---
  const snapshot = await createRunSnapshot({
    dirs,
    manifest,
    adapter,
    runtime: installed.runtime.kind,
    installationFingerprint: installed.runtime.fingerprint,
    resolvedInputPath,
    suppliedParams: options.params ?? {},
    effectiveParams,
    signal: options.signal,
  });
  if (!snapshot.ok) return { status: snapshot.record.status as RunModelResult["status"], record: snapshot.record };
  const { record, startedAt, storedInputPath, companionInputs } = snapshot;

  const runContext: RunContext = {
    manifestName: manifest.name,
    inputPath: storedInputPath,
    outputDir,
    modelDir: installed.installDir,
    assetsDir: path.join(installed.installDir, "assets"),
    params: effectiveParams,
    runtimeExecutable: installed.runtime.python.executable,
    platform: installed.runtime.python.platform,
    ...(companionInputs.length > 0 ? { companionInputs } : {}),
  };

  try {
    // --- Step 7: build the structured command. ---
    const commandSpec = await adapter.command(runContext);
    record.command = {
      executable: commandSpec.executable,
      args: commandSpec.args,
      cwd: runDirPath,
      ...(commandSpec.env ? { env: redactEnv(commandSpec.env) } : {}),
    };

    // --- Step 8: execute. Rewritten to "running" with a real pid the instant the process spawns. ---
    const provider = options.runtimeProvider ?? new PythonRuntimeProvider();
    const execution = await provider.execute({
      executable: commandSpec.executable,
      args: commandSpec.args,
      cwd: runDirPath,
      env: commandSpec.env,
      signal: options.signal,
      onSpawn: (pid) => {
        record.status = "running";
        record.process = { pid };
        writeRunRecord(runDirPath, record);
      },
      // --- Step 9: live log tee for the CLI; the provider itself persists stdout.log/stderr.log. ---
      onStdout: (chunk) => options.onLog?.("stdout", chunk),
      onStderr: (chunk) => options.onLog?.("stderr", chunk),
    });
    record.logs = { stdout: execution.stdoutPath, stderr: execution.stderrPath };
    // `execution.pid` is optional per `ExecutionResult`; fall back to the pid already
    // captured via `onSpawn` rather than letting a provider that omits it erase the record.
    record.process = { pid: execution.pid ?? record.process?.pid, exitCode: execution.exitCode, signal: execution.signal };

    // --- Step 11: exit-code precedence — cancelled, then nonzero exit, then "exit 0 isn't sufficient". ---
    if (execution.cancelled) {
      record.status = "cancelled";
      record.error = { code: "RUN_CANCELLED", message: "Run was cancelled." };
    } else if (execution.exitCode !== 0) {
      record.status = "failed";
      record.error = {
        code: "RUN_EXECUTION_FAILED",
        message: `${modelName} exited with code ${execution.exitCode}.`,
      };
    } else {
      // --- Step 12: checksum + size each output. ---
      record.outputs = await collectRunOutputs(adapter, runContext);
      record.status = "succeeded";
    }
  } catch (error) {
    record.status = options.signal?.aborted ? "cancelled" : "failed";
    record.error = toErrorInfo(error, "RUN_EXECUTION_FAILED");
  }

  return finalizeRun({
    adapter,
    context: runContext,
    runDirPath,
    record,
    startedAt,
    signal: options.signal,
    visualize: options.visualize,
    outputDir: options.outputDir,
  });
}
