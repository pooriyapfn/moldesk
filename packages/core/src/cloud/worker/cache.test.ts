import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseManifest } from "@moldesk/registry";
import { acquireVolumeLock, cacheDirFor, cloudCacheKey, hashTree, publishCache, verifyCache } from "./cache.js";

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk cache "));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function manifest(patch: Record<string, unknown> = {}, layout = "1") {
  return parseManifest(
    {
      schemaVersion: 1,
      name: "m",
      displayName: "M",
      modelVersion: "1.0.0",
      adapterVersion: "0.1.0",
      description: "t",
      category: "other",
      status: "planned",
      source: { repository: "https://example.com/r", revision: "b".repeat(40) },
      runtimes: [{ kind: "python", python: "3.11", installer: "uv", platforms: ["linux-x64"], requirements: [{ name: "torch" }] }],
      hardware: { platforms: ["linux-x64"] },
      assets: [{ id: "w", url: "https://example.com/w.bin", sha256: "c".repeat(64), target: "w.bin" }],
      input: { formats: [".txt"], required: true },
      outputs: [{ id: "o", glob: "*.out", required: true }],
      cloud: { schemaVersion: 1, platform: "linux-x64", images: { gpu: `r.example/g@sha256:${"a".repeat(64)}`, cpu: `r.example/c@sha256:${"a".repeat(64)}` }, minVramGb: 24, minRamGb: 32, ephemeralDiskGb: 40, volumeGb: 40, assetLayoutRevision: layout, cpuAssetPreparation: true },
      ...patch,
    },
    "x/manifest.yaml",
  );
}

function stage(root: string, key: string): string {
  const staging = path.join(root, `${key}.staging-1`);
  fs.mkdirSync(path.join(staging, "assets", "sub"), { recursive: true });
  fs.writeFileSync(path.join(staging, "assets", "w.bin"), "weights");
  fs.writeFileSync(path.join(staging, "assets", "sub", "x.dat"), "data");
  return staging;
}

describe("cloudCacheKey", () => {
  it("is stable, and changes with assets, source revision, version and layout", () => {
    const base = cloudCacheKey(manifest());
    expect(cloudCacheKey(manifest())).toBe(base);
    expect(cloudCacheKey(manifest({}, "2"))).not.toBe(base);
    expect(cloudCacheKey(manifest({ assets: [{ id: "w", url: "https://example.com/w.bin", sha256: "d".repeat(64), target: "w.bin" }] }))).not.toBe(base);
    expect(cloudCacheKey(manifest({ source: { repository: "https://example.com/r", revision: "e".repeat(40) } }))).not.toBe(base);
    expect(cloudCacheKey(manifest({ modelVersion: "1.0.1" }))).not.toBe(base);
  });
});

describe("publishCache / verifyCache", () => {
  const params = (root: string, key = "k1") => ({ root, key, manifestDigest: "md", layoutRevision: "1" });

  it("publishes atomically and verifies a warm cache", async () => {
    const root = tmp();
    const meta = await publishCache({ ...params(root), stagingDir: stage(root, "k1") });
    expect(meta.files.map((f) => f.path)).toEqual(["assets/sub/x.dat", "assets/w.bin"]);
    expect(fs.existsSync(path.join(root, "k1.staging-1"))).toBe(false);
    const result = await verifyCache(params(root));
    expect(result).toMatchObject({ ok: true, assetsDir: path.join(root, "k1", "assets") });
  });

  it("reports missing, wrong-key, mutated, added and symlinked caches as unusable", async () => {
    const root = tmp();
    expect(await verifyCache(params(root))).toMatchObject({ ok: false, code: "CLOUD_CACHE_MISSING" });
    await publishCache({ ...params(root), stagingDir: stage(root, "k1") });
    expect(await verifyCache({ ...params(root), manifestDigest: "other" })).toMatchObject({ ok: false, code: "CLOUD_CACHE_INVALID" });
    expect(await verifyCache({ ...params(root), layoutRevision: "2" })).toMatchObject({ ok: false, code: "CLOUD_CACHE_INVALID" });

    fs.writeFileSync(path.join(root, "k1", "assets", "w.bin"), "tampered");
    expect(await verifyCache(params(root))).toMatchObject({ ok: false, code: "CLOUD_CACHE_INVALID", message: expect.stringMatching(/no longer match/) });

    const added = tmp();
    await publishCache({ ...params(added), stagingDir: stage(added, "k1") });
    fs.writeFileSync(path.join(added, "k1", "assets", "extra.bin"), "x");
    expect(await verifyCache(params(added))).toMatchObject({ ok: false, code: "CLOUD_CACHE_INVALID" });

    const linked = tmp();
    await publishCache({ ...params(linked), stagingDir: stage(linked, "k1") });
    fs.symlinkSync("/etc/passwd", path.join(linked, "k1", "assets", "link"));
    expect(await verifyCache(params(linked))).toMatchObject({ ok: false, message: expect.stringMatching(/symlink/) });
  });

  it("detects a tampered checksum manifest", async () => {
    const root = tmp();
    await publishCache({ ...params(root), stagingDir: stage(root, "k1") });
    const readyPath = path.join(root, "k1", "ready.json");
    const meta = JSON.parse(fs.readFileSync(readyPath, "utf8"));
    meta.files[0].sha256 = "0".repeat(64);
    fs.writeFileSync(readyPath, JSON.stringify(meta));
    expect(await verifyCache(params(root))).toMatchObject({ ok: false, message: expect.stringMatching(/altered/) });
  });

  it("an interrupted preparation (no publish) is never reachable as READY", async () => {
    const root = tmp();
    stage(root, "k1"); // staging exists, publish never ran
    expect(await verifyCache(params(root))).toMatchObject({ ok: false, code: "CLOUD_CACHE_MISSING" });
    expect(fs.existsSync(cacheDirFor(root, "k1"))).toBe(false);
  });

  it("hashTree refuses unsafe entries", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "ok"), "x");
    fs.symlinkSync("ok", path.join(dir, "ln"));
    await expect(hashTree(dir)).rejects.toMatchObject({ code: "CLOUD_CACHE_UNSAFE" });
  });
});

describe("acquireVolumeLock", () => {
  it("excludes a second holder, releases cleanly, and reclaims stale locks only when asserted", () => {
    const root = tmp();
    let now = 1_000;
    const take = (extra: Record<string, unknown> = {}) => acquireVolumeLock({ root, key: "k", owner: "a", ttlSeconds: 10, now: () => now, ...extra });
    const first = take();
    expect(() => take()).toThrow(expect.objectContaining({ code: "CLOUD_CACHE_LOCKED" }));
    first.release();
    const second = take();
    now += 60_000;
    expect(() => take()).toThrow(expect.objectContaining({ code: "CLOUD_CACHE_LOCKED" })); // stale but not asserted gone
    const reclaimed = take({ reclaimStale: true });
    reclaimed.release();
    second.release();
  });

  it("does not reclaim a live lock even when asked", () => {
    const root = tmp();
    acquireVolumeLock({ root, key: "k", owner: "a", ttlSeconds: 600, now: () => 1_000 });
    expect(() => acquireVolumeLock({ root, key: "k", owner: "b", ttlSeconds: 600, reclaimStale: true, now: () => 2_000 })).toThrow(expect.objectContaining({ code: "CLOUD_CACHE_LOCKED" }));
  });
});
