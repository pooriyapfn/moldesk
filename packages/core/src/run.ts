import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAdapter, validateParams } from "@moldesk/adapters";
import { listAvailableModels, type RuntimeKind } from "@moldesk/registry";
import {
  getMoldeskPaths,
  getSystemReport,
  redactEnv,
  runDir,
  PythonRuntimeProvider,
  type MoldeskPaths,
  type RuntimeProvider,
  type SystemReport,
} from "@moldesk/runtime";
import { MoldeskError } from "./errors.js";
import { digest, sha256File } from "./hash.js";
import { listInstalledModels } from "./install-state.js";
import { VERSION } from "./version.js";

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
  input: Array<{ originalPath: string; storedPath: string; sha256: string }>;
  parameters: { supplied: Record<string, unknown>; effective: Record<string, unknown> };
  command: { executable: string; args: string[]; cwd: string; env?: Record<string, string> };
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  process?: { pid?: number; exitCode?: number; signal?: string };
  outputs: Array<{ id: string; path: string; sha256: string; sizeBytes: number }>;
  logs: { stdout: string; stderr: string };
  error?: { code: string; message: string };
}

export interface RunModelResult {
  status: "succeeded" | "failed" | "cancelled";
  record: RunRecord;
  /** Set only if `--output` copy failed after an otherwise-succeeded run; see the module doc. */
  exportError?: { code: string; message: string };
}

function runFailure(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

function toErrorInfo(error: unknown, fallbackCode: string): { code: string; message: string } {
  if (error instanceof MoldeskError) return { code: error.code, message: error.message };
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

function writeRunRecord(runDirPath: string, record: RunRecord): void {
  const file = path.join(runDirPath, "run.json");
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export async function runModel(
  modelName: string,
  inputPath: string,
  options: RunModelOptions = {},
): Promise<RunModelResult> {
  const paths = options.paths ?? getMoldeskPaths();

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
  const { effective: effectiveParams, errors: paramErrors } = validateParams(adapter.params ?? [], options.params ?? {});
  if (paramErrors.length > 0) {
    throw runFailure("INVALID_RUN_PARAMS", paramErrors.join("; "), "Fix the listed --param values and retry.", { errors: paramErrors });
  }

  // --- Step 4: allocate run ID and directory. From here on, every outcome resolves. ---
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const runDirPath = runDir(runId, { MOLDESK_HOME: paths.home });
  const inputDir = path.join(runDirPath, "input");
  const outputDir = path.join(runDirPath, "output");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // --- Step 5: copy/snapshot the original input. ---
  const storedInputPath = path.join(inputDir, path.basename(resolvedInputPath));
  fs.copyFileSync(resolvedInputPath, storedInputPath);
  const inputSha256 = await sha256File(storedInputPath);

  const hardware = await getSystemReport();
  const startedAt = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 1,
    id: runId,
    status: "preparing",
    model: manifest.name,
    modelVersion: manifest.modelVersion,
    adapterVersion: manifest.adapterVersion,
    moldeskVersion: VERSION,
    runtime: installed.runtime.kind,
    installationFingerprint: installed.runtime.fingerprint,
    manifestSha256: digest(manifest),
    hardware,
    input: [{ originalPath: resolvedInputPath, storedPath: storedInputPath, sha256: inputSha256 }],
    parameters: { supplied: options.params ?? {}, effective: effectiveParams },
    command: { executable: "", args: [], cwd: runDirPath },
    startedAt,
    outputs: [],
    logs: { stdout: path.join(runDirPath, "stdout.log"), stderr: path.join(runDirPath, "stderr.log") },
  };

  // --- Step 6: write the initial record. From this point, every path below finalizes run.json. ---
  writeRunRecord(runDirPath, record);

  try {
    // --- Step 7: build the structured command. ---
    const commandSpec = await adapter.command({
      manifestName: manifest.name,
      inputPath: storedInputPath,
      outputDir,
      modelDir: installed.installDir,
      assetsDir: path.join(installed.installDir, "assets"),
      params: effectiveParams,
      runtimeExecutable: installed.runtime.python.executable,
    });
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
      const collected = await adapter.collectOutputs({
        manifestName: manifest.name,
        inputPath: storedInputPath,
        outputDir,
        modelDir: installed.installDir,
        assetsDir: path.join(installed.installDir, "assets"),
        params: effectiveParams,
        runtimeExecutable: installed.runtime.python.executable,
      });
      // --- Step 12: checksum + size each output. ---
      record.outputs = await Promise.all(
        collected.map(async (output) => ({
          id: output.id,
          path: output.path,
          sha256: await sha256File(output.path),
          sizeBytes: fs.statSync(output.path).size,
        })),
      );
      record.status = "succeeded";
    }
  } catch (error) {
    record.status = options.signal?.aborted ? "cancelled" : "failed";
    record.error = toErrorInfo(error, "RUN_EXECUTION_FAILED");
  }

  // --- Step 13: write the final record atomically. ---
  const finishedAt = new Date().toISOString();
  record.finishedAt = finishedAt;
  record.durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  writeRunRecord(runDirPath, record);

  const result: RunModelResult = { status: record.status as RunModelResult["status"], record };

  // --- --output: a distinct, post-finalization copy step; never changes the run's own status. ---
  if (result.status === "succeeded" && options.outputDir) {
    try {
      fs.mkdirSync(options.outputDir, { recursive: true });
      for (const output of record.outputs) {
        const target = path.join(options.outputDir, path.basename(output.path));
        fs.copyFileSync(output.path, target, fs.constants.COPYFILE_EXCL);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.exportError = { code: "OUTPUT_COLLISION", message };
    }
  }

  return result;
}
