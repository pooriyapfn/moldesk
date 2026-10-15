import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { RemoteResourceUsage } from "@moldesk/runtime";

export interface ProbeSamplers {
  /** Used and total bytes of the filesystem holding `path`; undefined if it cannot be read. */
  disk(path: string): { usedBytes: number; totalBytes: number } | undefined;
  /** Highest GPU memory in use right now across GPUs, in MiB; undefined without a readable GPU. */
  vramUsedMb(): Promise<number | undefined>;
}

export interface ResourceProbeOptions {
  /** Directories whose filesystems are watched; filesystems that appear twice are reported once. */
  paths: string[];
  intervalMs?: number;
  samplers?: Partial<ProbeSamplers>;
}

export interface ResourceProbe {
  /** Takes a last sample, stops sampling and returns the peaks. Safe to call more than once. */
  stop(): Promise<RemoteResourceUsage>;
}

const DEFAULT_INTERVAL_MS = 250;

function diskSample(target: string): { usedBytes: number; totalBytes: number } | undefined {
  try {
    const stats = fs.statfsSync(target);
    const blockSize = Number(stats.bsize);
    return { usedBytes: (Number(stats.blocks) - Number(stats.bfree)) * blockSize, totalBytes: Number(stats.blocks) * blockSize };
  } catch {
    return undefined;
  }
}

function vramSample(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const values = stdout.split("\n").map((line) => Number.parseInt(line.trim(), 10)).filter((value) => Number.isFinite(value) && value >= 0);
      resolve(values.length > 0 ? Math.max(...values) : undefined);
    });
  });
}

/** The job directory plus the root and temp filesystems, so the report holds whichever one the container disk is. */
export function probePaths(jobDir: string): string[] {
  const seen = new Set<number>();
  const result: string[] = [];
  for (const candidate of [jobDir, "/", os.tmpdir()]) {
    try {
      const device = fs.statSync(candidate).dev;
      if (seen.has(device)) continue;
      seen.add(device);
      result.push(candidate);
    } catch {
      // A path that cannot be inspected is simply not probed.
    }
  }
  return result;
}

/**
 * Measures the peak disk and GPU memory a job needs so a manifest's `cloud` sizes can be set from real
 * runs. Disk is the filesystem's used bytes (the image's own files included), so the growth since the probe
 * started is the job's footprint. A sampler failure never affects the job.
 */
export function startResourceProbe(options: ResourceProbeOptions): ResourceProbe {
  const samplers: ProbeSamplers = { disk: diskSample, vramUsedMb: vramSample, ...options.samplers };
  const disk = new Map<string, { totalBytes: number; startUsedBytes: number; peakUsedBytes: number }>();
  let peakVramMb: number | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped: Promise<RemoteResourceUsage> | undefined;

  const sampleDisk = (): void => {
    for (const target of options.paths) {
      const sample = samplers.disk(target);
      if (!sample) continue;
      const known = disk.get(target);
      if (!known) disk.set(target, { totalBytes: sample.totalBytes, startUsedBytes: sample.usedBytes, peakUsedBytes: sample.usedBytes });
      else known.peakUsedBytes = Math.max(known.peakUsedBytes, sample.usedBytes);
    }
  };
  const sampleVram = (): Promise<void> => {
    // One nvidia-smi at a time: a slow call is skipped rather than queued.
    inFlight ??= samplers
      .vramUsedMb()
      .then((value) => {
        if (value !== undefined) peakVramMb = Math.max(peakVramMb ?? 0, value);
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const sample = (): void => {
    sampleDisk();
    void sampleVram();
  };

  sample();
  const timer = setInterval(sample, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();

  return {
    stop() {
      stopped ??= (async () => {
        clearInterval(timer);
        sampleDisk();
        await sampleVram();
        return {
          ...(peakVramMb !== undefined ? { peakVramMb } : {}),
          disk: [...disk].map(([diskPath, value]) => ({ path: diskPath, ...value })),
        };
      })();
      return stopped;
    },
  };
}
