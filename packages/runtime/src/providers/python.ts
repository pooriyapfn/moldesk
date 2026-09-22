import fs from "node:fs";
import path from "node:path";
import { MoldeskError } from "@moldesk/registry";
import { runCommand } from "../process/index.js";
import { detectPython } from "../python/index.js";
import type {
  ExecuteRequest,
  ExecutionResult,
  PrepareRuntimeRequest,
  PreparedRuntime,
  RemoveRuntimeRequest,
  RuntimeCapability,
  RuntimeProvider,
} from "../providers.js";

/** Model runs have no fixed duration; termination is driven only by `signal`/graceful cancellation, not a timer. */
const NO_TIMEOUT_MS = 0;
const EXECUTE_GRACEFUL_TIMEOUT_MS = 5_000;

/**
 * Executes already-installed Python models. Resolves the interpreter from
 * the on-disk managed venv (`prepare`) and streams process output to
 * `stdout.log`/`stderr.log` under the caller-supplied `cwd` while also
 * forwarding chunks live (`execute`).
 */
export class PythonRuntimeProvider implements RuntimeProvider {
  readonly kind = "python" as const;

  async inspect(): Promise<RuntimeCapability> {
    const python = await detectPython();
    return {
      kind: "python",
      available: python.available,
      version: python.version,
      error: python.error,
    };
  }

  async prepare(request: PrepareRuntimeRequest): Promise<PreparedRuntime> {
    const executable = path.join(request.targetDir, ".venv", "bin", "python");
    if (!fs.existsSync(executable)) {
      throw new MoldeskError({
        code: "MODEL_NOT_INSTALLED",
        message: `No managed Python environment found for "${request.modelName}" at ${executable}.`,
        remediation: `Run "moldesk install ${request.modelName}" first.`,
        details: { modelName: request.modelName, targetDir: request.targetDir },
      });
    }
    return { kind: "python", executable, fingerprint: request.runtimeFingerprint };
  }

  async execute(request: ExecuteRequest): Promise<ExecutionResult> {
    const stdoutPath = path.join(request.cwd, "stdout.log");
    const stderrPath = path.join(request.cwd, "stderr.log");
    const stdoutFd = fs.openSync(stdoutPath, "a");
    const stderrFd = fs.openSync(stderrPath, "a");
    try {
      const result = await runCommand(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        timeoutMs: NO_TIMEOUT_MS,
        gracefulTimeoutMs: EXECUTE_GRACEFUL_TIMEOUT_MS,
        signal: request.signal,
        onSpawn: request.onSpawn,
        onStdout: (chunk) => {
          fs.writeSync(stdoutFd, chunk);
          request.onStdout?.(chunk);
        },
        onStderr: (chunk) => {
          fs.writeSync(stderrFd, chunk);
          request.onStderr?.(chunk);
        },
      });
      return {
        exitCode: result.code,
        stdoutPath,
        stderrPath,
        pid: result.pid,
        signal: result.signal,
        cancelled: result.cancelled,
      };
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
  }

  async remove(_request: RemoveRuntimeRequest): Promise<void> {
    // No-op: uninstall already owns Python environment removal; kept for interface parity with a future Docker provider.
  }
}
