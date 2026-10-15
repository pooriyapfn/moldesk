import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { probePaths, startResourceProbe } from "./probe.js";

describe("resource probe", () => {
  it("keeps the highest VRAM and disk values seen and the disk value from when it started", async () => {
    const disk = [100, 400, 250, 300];
    const vram = [200, 900, 500];
    const probe = startResourceProbe({
      paths: ["/work"],
      intervalMs: 5,
      samplers: {
        disk: () => ({ usedBytes: disk.length > 1 ? disk.shift()! : disk[0]!, totalBytes: 1000 }),
        vramUsedMb: async () => (vram.length > 1 ? vram.shift()! : vram[0]!),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const usage = await probe.stop();
    expect(usage.peakVramMb).toBe(900);
    expect(usage.disk).toEqual([{ path: "/work", totalBytes: 1000, startUsedBytes: 100, peakUsedBytes: 400 }]);
  });

  it("stops sampling and returns the same result when stopped twice", async () => {
    let calls = 0;
    const probe = startResourceProbe({ paths: ["/work"], intervalMs: 5, samplers: { disk: () => ({ usedBytes: ++calls, totalBytes: 10 }), vramUsedMb: async () => undefined } });
    const first = await probe.stop();
    const seen = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(seen);
    expect(await probe.stop()).toBe(first);
    expect(first.peakVramMb).toBeUndefined();
  });

  it("survives samplers that fail or find nothing", async () => {
    const probe = startResourceProbe({
      paths: ["/missing"],
      intervalMs: 5,
      samplers: {
        disk: () => undefined,
        vramUsedMb: async () => {
          throw new Error("nvidia-smi gone");
        },
      },
    });
    expect(await probe.stop()).toEqual({ disk: [] });
  });

  it("reads real filesystems and lists each filesystem once", async () => {
    const dir = fs.mkdtempSync(`${os.tmpdir()}/moldesk-probe-`);
    try {
      const paths = probePaths(dir);
      expect(paths[0]).toBe(dir);
      expect(new Set(paths.map((entry) => fs.statSync(entry).dev)).size).toBe(paths.length);
      const usage = await startResourceProbe({ paths, samplers: { vramUsedMb: async () => undefined } }).stop();
      expect(usage.disk.length).toBe(paths.length);
      for (const entry of usage.disk) expect(entry.peakUsedBytes).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
