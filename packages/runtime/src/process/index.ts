import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
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
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore kill failures; close handler settles below
            }
          }, timeoutMs)
        : undefined;

    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      options.onStderr?.(text);
    });

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
      });
    });

    child.on("close", (code) => {
      if (timedOut) {
        settle({
          code: 124,
          stdout,
          stderr: `${stderr}command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`.trim(),
          timedOut: true,
        });
        return;
      }
      settle({ code: code ?? 0, stdout, stderr });
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
