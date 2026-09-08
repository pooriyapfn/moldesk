import type { CaptureFn } from "../process/index.js";
import type { ToolCapability } from "../python/index.js";

export interface DockerCapability extends ToolCapability {
  running: boolean;
  gpuAccess: "available" | "unavailable" | "unknown";
}

export type DockerInfo = DockerCapability;

const PROBE_TIMEOUT_MS = 10_000;

function parseDockerVersion(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  // "Docker version 24.0.7, build abc" -> "24.0.7, build abc"
  const withoutPrefix = trimmed.replace(/^Docker version\s+/i, "").trim();
  return withoutPrefix.length > 0 ? withoutPrefix : undefined;
}

/**
 * Tier-1 GPU signal: does the target daemon (local or remote, via `docker
 * info`'s `Runtimes` map) have an `nvidia` container runtime registered?
 * This does NOT prove a container can actually reach the GPU — registration
 * alone can't confirm that — so a registered runtime only ever resolves to
 * `"unknown"`, never `"available"`. Only an explicit Tier-2 probe (a real
 * `docker run --gpus all ... nvidia-smi`, run by `install.ts`, never by
 * `doctor`/`list`) can confirm `"available"`.
 */
function dockerHasNvidiaRuntime(infoJson: unknown): boolean | undefined {
  if (typeof infoJson !== "object" || infoJson === null) return undefined;
  const runtimes = (infoJson as Record<string, unknown>)["Runtimes"];
  if (typeof runtimes !== "object" || runtimes === null) return undefined;
  return Object.keys(runtimes).some((k) => k.toLowerCase().includes("nvidia"));
}

function resolveGpuAccess(
  nvidiaRuntimeRegistered: boolean | undefined,
  override?: DockerCapability["gpuAccess"],
): DockerCapability["gpuAccess"] {
  if (override) return override;
  if (nvidiaRuntimeRegistered === undefined) return "unknown";
  return nvidiaRuntimeRegistered ? "unknown" : "unavailable";
}

/**
 * Detect Docker install + daemon state. Tier-1 GPU signal (a registered
 * `nvidia` runtime) is derived for free from `docker info` — no pulls, safe
 * for `doctor`/`list`. Pass `options.gpuAccess` to inject a Tier-2 verified
 * probe result (`install.ts` only).
 */
export async function detectDocker(
  capture?: CaptureFn,
  options: { timeoutMs?: number; gpuAccess?: DockerCapability["gpuAccess"] } = {},
): Promise<DockerCapability> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  let run: CaptureFn;
  if (capture) {
    run = capture;
  } else {
    const { defaultCapture } = await import("../process/index.js");
    run = defaultCapture;
  }
  const versionResult = await run("docker", ["--version"], { timeoutMs });
  if (versionResult.timedOut) {
    return {
      available: false,
      running: false,
      gpuAccess: "unknown",
      error: `docker --version timed out after ${timeoutMs}ms`,
    };
  }
  if (versionResult.code !== 0) {
    const detail = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
    return {
      available: false,
      running: false,
      gpuAccess: "unknown",
      error:
        detail.length > 0
          ? `docker not detected: ${detail.split("\n")[0]}`
          : "docker not detected on PATH",
    };
  }
  const version = parseDockerVersion(versionResult.stdout);
  const infoJsonResult = await run("docker", ["info", "--format", "{{json .}}"], { timeoutMs });
  if (infoJsonResult.timedOut) {
    return {
      available: true,
      running: false,
      version,
      gpuAccess: options.gpuAccess ?? "unknown",
      error: `docker info timed out after ${timeoutMs}ms; daemon state unknown`,
    };
  }
  if (infoJsonResult.code !== 0) {
    return {
      available: true,
      running: false,
      version,
      gpuAccess: options.gpuAccess ?? "unknown",
      error: "docker installed but daemon not running (docker info failed)",
    };
  }
  let nvidiaRuntimeRegistered: boolean | undefined;
  try {
    nvidiaRuntimeRegistered = dockerHasNvidiaRuntime(JSON.parse(infoJsonResult.stdout));
  } catch {
    nvidiaRuntimeRegistered = undefined;
  }
  return {
    available: true,
    running: true,
    version,
    gpuAccess: resolveGpuAccess(nvidiaRuntimeRegistered, options.gpuAccess),
  };
}

const DEFAULT_PULL_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Tier-2: is the (small, digest-pinned) GPU-probe image already cached locally? */
export async function isImageCachedLocally(
  image: string,
  capture?: CaptureFn,
): Promise<boolean> {
  const run = capture ?? (await import("../process/index.js")).defaultCapture;
  const result = await run("docker", ["image", "inspect", image], { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
  return !result.timedOut && result.code === 0;
}

/**
 * Tier-2: explicitly pull the GPU-probe image. Kept separate from
 * `probeDockerGpuAccess` so a slow download uses its own (longer) timeout
 * and can never be mistaken for a GPU-probe failure.
 */
export async function pullDockerImage(
  image: string,
  capture?: CaptureFn,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
  const run = capture ?? (await import("../process/index.js")).defaultCapture;
  const result = await run("docker", ["pull", image], { timeoutMs });
  if (result.timedOut) return { ok: false, error: `docker pull timed out after ${timeoutMs}ms` };
  if (result.code !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    return { ok: false, error: detail.length > 0 ? detail.split("\n").at(-1) : "docker pull failed" };
  }
  return { ok: true };
}

/**
 * Tier-2: authoritative GPU-access probe. Runs a real container with
 * `--gpus all`; `--pull=never` guarantees this call can never itself trigger
 * an implicit (slow) pull, so its short timeout can't produce a false
 * failure. The image must already be present locally — call
 * `isImageCachedLocally`/`pullDockerImage` first.
 */
export async function probeDockerGpuAccess(
  image: string,
  capture?: CaptureFn,
  options: { timeoutMs?: number } = {},
): Promise<{ access: "available" | "unavailable"; error?: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const run = capture ?? (await import("../process/index.js")).defaultCapture;
  const result = await run(
    "docker",
    ["run", "--rm", "--gpus", "all", "--pull=never", image, "nvidia-smi", "-L"],
    { timeoutMs },
  );
  if (result.timedOut) return { access: "unavailable", error: `GPU probe timed out after ${timeoutMs}ms` };
  if (result.code !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    return { access: "unavailable", error: detail.length > 0 ? detail.split("\n")[0] : "docker GPU probe failed" };
  }
  return { access: "available" };
}
