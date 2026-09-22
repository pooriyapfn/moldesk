import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getMoldeskHome } from "../filesystem/index.js";

export interface HardwareInfo {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryGb: number;
  isAppleSilicon: boolean;
}

export function getHardwareInfo(): HardwareInfo {
  const cpus = os.cpus();
  const arch = os.arch();
  const platform = os.platform();

  return {
    platform,
    arch,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCores: cpus.length,
    totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    isAppleSilicon: platform === "darwin" && arch === "arm64",
  };
}

export interface DiskInfo {
  availableBytes: number;
  path: string;
  /** True when the statfs probe failed/was unsupported — `availableBytes: 0` is a conservative placeholder, not a real reading. */
  probeFailed?: boolean;
  /** Captured error/reason when `probeFailed` is true. */
  probeError?: string;
}

function nearestExistingParent(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    try {
      if (fs.existsSync(current)) return current;
    } catch {
      // fall through to parent walk
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export type StatFsFn = (
  target: string,
) => Promise<{ availableBytes: number } | null>;

/** Default disk probe via `fs.statfs` (Node >= 19). Returns null when unavailable. */
export const defaultStatFs: StatFsFn = async (target: string) => {
  const statfs = (
    fs.promises as unknown as {
      statfs?: (p: string) => Promise<{ bavail: number; bsize: number }>;
    }
  ).statfs;
  if (typeof statfs !== "function") return null;
  try {
    const stats = await statfs(target);
    const available =
      typeof stats.bavail === "number" && typeof stats.bsize === "number"
        ? stats.bavail * stats.bsize
        : Number.NaN;
    if (!Number.isFinite(available) || available < 0) return null;
    return { availableBytes: Math.floor(available) };
  } catch {
    return null;
  }
};

/**
 * Query free space at MOLDESK_HOME (or nearest existing parent).
 * Never throws: on probe failure reports `availableBytes: 0` with
 * `probeFailed: true` so callers can distinguish "genuinely 0 bytes free"
 * (probeFailed absent) from "could not be determined" (probeFailed true) —
 * the two must not be treated the same by compatibility evaluation.
 */
export async function getDiskInfo(
  env: NodeJS.ProcessEnv = process.env,
  statfs: StatFsFn = defaultStatFs,
): Promise<DiskInfo> {
  const home = getMoldeskHome(env);
  const target = nearestExistingParent(home);
  try {
    const result = await statfs(target);
    if (result) return { availableBytes: result.availableBytes, path: target };
    return { availableBytes: 0, path: target, probeFailed: true, probeError: "disk space probe unsupported or failed" };
  } catch (error) {
    return {
      availableBytes: 0,
      path: target,
      probeFailed: true,
      probeError: error instanceof Error ? error.message : "disk space probe threw an unexpected error",
    };
  }
}
