import os from "node:os";
import { getDiskInfo, type DiskInfo } from "./hardware/index.js";
import type { StatFsFn } from "./hardware/index.js";
import { detectPython, type ToolCapability } from "./python/index.js";
import { detectDocker, type DockerCapability } from "./docker/index.js";
import { detectNvidia, type NvidiaCapability, type NvidiaGpu } from "./nvidia/index.js";
import type { CaptureFn } from "./process/index.js";

export type { ToolCapability, DockerCapability, NvidiaCapability, NvidiaGpu, DiskInfo };

export interface SystemReport {
  capturedAt: string;
  platform: "darwin" | "linux" | "win32" | "unknown";
  arch: string;
  cpu: { model: string; logicalCores: number };
  memory: { totalBytes: number };
  disk: DiskInfo;
  appleSilicon: boolean;
  /** Host interpreter: diagnostic context only, never required for managed runtimes. */
  hostPython: ToolCapability;
  docker: DockerCapability;
  nvidia: NvidiaCapability;
}

export interface SystemReportDeps {
  capture?: CaptureFn;
  statfs?: StatFsFn;
  platform?: NodeJS.Platform | string;
  arch?: string;
  /** Tier-2 verified Docker GPU-access result to inject (install.ts only). */
  dockerGpuAccess?: DockerCapability["gpuAccess"];
}

function normalizePlatform(raw: string): SystemReport["platform"] {
  if (raw === "darwin" || raw === "linux" || raw === "win32") return raw;
  return "unknown";
}

/**
 * Build one normalized machine report. Cached only within a single CLI
 * invocation by the caller; hardware may change between runs so this
 * function never persists anything.
 */
export async function collectSystemReport(
  deps: SystemReportDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SystemReport> {
  const rawPlatform = deps.platform ?? os.platform();
  const platform = normalizePlatform(rawPlatform);
  const arch = deps.arch ?? os.arch();
  const cpus = os.cpus();

  const [disk, hostPython, docker, nvidia] = await Promise.all([
    getDiskInfo(env, deps.statfs),
    detectPython(deps.capture),
    detectDocker(deps.capture, { gpuAccess: deps.dockerGpuAccess }),
    detectNvidia(deps.capture),
  ]);

  return {
    capturedAt: new Date().toISOString(),
    platform,
    arch,
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      logicalCores: cpus.length,
    },
    memory: { totalBytes: os.totalmem() },
    disk,
    appleSilicon: platform === "darwin" && arch === "arm64",
    hostPython,
    docker,
    nvidia,
  };
}
