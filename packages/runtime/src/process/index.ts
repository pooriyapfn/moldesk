import { spawn } from "node:child_process";

export interface RunOptions {
  /** Kill the child when combined captured output exceeds this byte limit. */
  maxOutputBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** External cancellation trigger, e.g. wired to CLI SIGINT/SIGTERM handlers. */
  signal?: AbortSignal;
  /**
   * If set, a timeout or `signal` abort sends SIGTERM first and waits up to
   * this many ms before escalating to SIGKILL. If unset (the default),
   * termination is an immediate SIGKILL — this is the pre-existing behavior,
   * unchanged, so callers that don't pass it keep identical semantics.
   */
  gracefulTimeoutMs?: number;
  /** Called synchronously once the child is spawned, so callers can persist the pid before the promise resolves. */
  onSpawn?: (pid: number) => void;
}

export interface RunResult {
  outputLimitExceeded?: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  pid?: number;
  signal?: string;
  /** True when termination was triggered by `options.signal` aborting (distinct from a `timeoutMs` timeout). */
  cancelled?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Spawn a command without a shell (never `sh -c`). Resolves on close;
 * timeouts kill the child and resolve with `timedOut: true` instead of
 * rejecting, so probes can degrade to capability results.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gracefulTimeoutMs = options.gracefulTimeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (typeof child.pid === "number") {
      options.onSpawn?.(child.pid);
    }

    let stdout = "";
    let stderr = "";

    const terminate = (): void => {
      try {
        if (gracefulTimeoutMs && gracefulTimeoutMs > 0) {
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore kill failures; close handler settles below
            }
          }, gracefulTimeoutMs);
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore kill failures; close handler settles below
      }
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeoutMs)
        : undefined;

    const onAbort = (): void => {
      if (settled || timedOut) return;
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}) });
    };

    const capture = (data: Buffer, stream: "stdout" | "stderr"): void => {
      if (outputLimitExceeded) return;
      outputBytes += data.length;
      const limit = options.maxOutputBytes ?? Infinity;
      const text = data.subarray(0, Math.max(0, data.length - Math.max(0, outputBytes - limit))).toString();
      if (stream === "stdout") { stdout += text; options.onStdout?.(text); }
      else { stderr += text; options.onStderr?.(text); }
      if (outputBytes > limit) { outputLimitExceeded = true; terminate(); }
    };
    child.stdout.on("data", (data: Buffer) => capture(data, "stdout"));
    child.stderr.on("data", (data: Buffer) => capture(data, "stderr"));

    child.on("error", (error: Error) => {
      const suffix =
        timedOut || /timed out/i.test(error.message)
          ? ` (timed out after ${timeoutMs}ms)`
          : "";
      settle({
        code: 127,
        stdout,
        stderr: `${stderr}${error.message}${suffix}`,
        timedOut,
        cancelled,
        pid: child.pid,
      });
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        settle({
          code: 124,
          stdout,
          stderr: `${stderr}command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`.trim(),
          timedOut: true,
          pid: child.pid,
          signal: signal ?? undefined,
        });
        return;
      }
      settle({
        code: code ?? 0,
        stdout,
        stderr,
        cancelled,
        pid: child.pid,
        signal: signal ?? undefined,
      });
    });
  });
}

/** Minimal capture result for probes. */
export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type CaptureFn = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<CaptureResult>;

/** Default capture backed by runCommand. */
export const defaultCapture: CaptureFn = (command, args, options) =>
  runCommand(command, args, { timeoutMs: options?.timeoutMs ?? 10_000 });
