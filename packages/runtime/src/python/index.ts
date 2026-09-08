import type { CaptureFn } from "../process/index.js";

export interface ToolCapability {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

/** Legacy alias kept for existing imports. */
export type PythonInfo = ToolCapability & { found?: boolean };

const PROBE_TIMEOUT_MS = 10_000;

function parseVersion(stdout: string): string | undefined {
  const cleaned = stdout.trim().replace(/^Python\s+/, "").split(/\s+/)[0];
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Detect the host Python interpreter for diagnostics only.
 * Missing tools / timeouts / permission errors become capability
 * results rather than crashes. Never required for managed runtimes.
 */
export async function detectPython(
  capture?: CaptureFn,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ToolCapability> {
  if (!capture) {
    const { defaultCapture } = await import("../process/index.js");
    capture = defaultCapture;
  }
  for (const cmd of ["python3", "python"]) {
    const versionResult = await capture(cmd, ["--version"], { timeoutMs });
    if (versionResult.timedOut) {
      return {
        available: false,
        error: `${cmd} --version timed out after ${timeoutMs}ms`,
      };
    }
    if (versionResult.code !== 0) continue;
    // `python --version` may print to stderr on some interpreters.
    const combined = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
    const version = parseVersion(combined);
    let detectedPath: string | undefined;
    const pathResult = await capture("which", [cmd], { timeoutMs });
    if (pathResult.code === 0) {
      const firstLine = pathResult.stdout.split("\n").map((l) => l.trim()).find(Boolean);
      detectedPath = firstLine;
    }
    return { available: true, version, path: detectedPath };
  }
  return { available: false, error: "no python3 or python interpreter on PATH" };
}
