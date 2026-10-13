import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMoldeskPaths, type CloudProvider, type CloudVolume } from "@moldesk/runtime";
import { executeCloudCacheDeletion, listCloudCaches, planCloudCacheDeletion } from "./manage.js";
import { CloudJournal } from "./state.js";

const dirs: string[] = [];
const RUN = "2026-10-13T11-55-45-123Z-0a1b2c3d-1111-2222-3333-444455556666";
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function box() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk manage "));
  dirs.push(home);
  const paths = getMoldeskPaths({ MOLDESK_HOME: home });
  const volumes = new Map<string, CloudVolume>();
  const state = { failDelete: false, stickyDelete: false, deleted: [] as string[] };
  const provider = {
    name: "runpod",
    listVolumes: async () => [...volumes.values()],
    getVolume: async (id: string) => volumes.get(id) ?? null,
    deleteVolume: async (id: string) => {
      if (state.failDelete) throw new Error("provider down");
      if (!state.stickyDelete) volumes.delete(id);
      state.deleted.push(id);
      return { id, alreadyAbsent: false };
    },
  } as unknown as CloudProvider;
  const journal = CloudJournal.open(paths);
  const seed = (model: string, volumeId: string, owned = true, key = "k".repeat(64)) => {
    volumes.set(volumeId, { id: volumeId, name: "n", sizeGb: 40, dataCenterId: "DC-1", type: "STANDARD" });
    if (owned) {
      const intent = journal.recordResourceIntent({ role: "volume" });
      if (!journal.findOwnedByProviderId(volumeId)) journal.recordResourceCreated(intent.intentId, volumeId);
    }
    journal.upsertCache({ accountScope: "acct", datacenterId: "DC-1", volumeId, model, modelVersion: "1", cacheKey: key, layoutRevision: "1", manifestDigest: "m", cachePath: "/workspace/x", sizeBytes: null, checksumManifestDigest: null });
  };
  const deps = { provider, paths, accountScope: "acct" };
  return { journal, volumes, state, seed, deps };
}

describe("cache management", () => {
  it("lists caches with whether the provider still has the volume", async () => {
    const b = box();
    b.seed("boltz", "vol1");
    b.volumes.delete("vol1");
    b.seed("other", "vol2");
    const listing = await listCloudCaches(b.deps);
    expect(listing.map((entry) => [entry.cache.model, entry.volumeExists])).toEqual([["boltz", false], ["other", true]]);
  });

  it("plans exactly the volumes for one model", async () => {
    const b = box();
    b.seed("boltz", "vol1");
    b.seed("other", "vol2");
    const plan = await planCloudCacheDeletion("boltz", b.deps);
    expect(plan).toEqual({ model: "boltz", volumes: [{ volumeId: "vol1", datacenterId: "DC-1", sizeGb: 40, cacheKeys: ["k".repeat(64)] }], blockers: [] });
  });

  it("blocks deletion while a run uses the volume or another model shares it", async () => {
    const b = box();
    b.seed("boltz", "vol1");
    b.journal.createJob({ runId: RUN, accountScope: "acct", quoteDigest: "q", cachePolicy: "persistent", deadlineAt: "2099-01-01T00:00:00.000Z", manifestDigest: "m" });
    b.journal.updateJob(RUN, { volumeId: "vol1", stage: "running" });
    b.seed("other", "vol1", true, "j".repeat(64));
    const plan = await planCloudCacheDeletion("boltz", b.deps);
    expect(plan.blockers.join(" ")).toMatch(/still using volume vol1/);
    expect(plan.blockers.join(" ")).toMatch(/also holds caches for: other/);
    await expect(executeCloudCacheDeletion(plan, b.deps)).rejects.toMatchObject({ code: "CLOUD_CACHE_IN_USE" });
    expect(b.state.deleted).toEqual([]);
  });

  it("deletes an owned volume, verifies it is gone, and removes the cache row", async () => {
    const b = box();
    b.seed("boltz", "vol1");
    const result = await executeCloudCacheDeletion(await planCloudCacheDeletion("boltz", b.deps), b.deps);
    expect(result).toEqual({ deleted: [{ volumeId: "vol1" }], failed: [] });
    expect(b.volumes.size).toBe(0);
    expect(b.journal.listCaches()).toHaveLength(0);
    expect(b.journal.findOwnedByProviderId("vol1")).toBeUndefined();
  });

  it("refuses to delete a volume this installation did not create", async () => {
    const b = box();
    b.seed("boltz", "vol1", false);
    const result = await executeCloudCacheDeletion(await planCloudCacheDeletion("boltz", b.deps), b.deps);
    expect(result.deleted).toEqual([]);
    expect(result.failed[0]!.reason).toMatch(/did not create/);
    expect(b.state.deleted).toEqual([]);
    expect(b.journal.listCaches()).toHaveLength(1);
  });

  it("reports provider failures and a volume that still exists after deletion, keeping the journal truthful", async () => {
    const b = box();
    b.seed("boltz", "vol1");
    b.state.failDelete = true;
    const failed = await executeCloudCacheDeletion(await planCloudCacheDeletion("boltz", b.deps), b.deps);
    expect(failed.failed[0]!.reason).toMatch(/provider down/);
    expect(b.journal.listCaches()).toHaveLength(1);

    b.state.failDelete = false;
    b.state.stickyDelete = true;
    const sticky = await executeCloudCacheDeletion(await planCloudCacheDeletion("boltz", b.deps), b.deps);
    expect(sticky.failed[0]!.reason).toMatch(/still lists the volume/);
    expect(b.journal.listCaches()).toHaveLength(1);
  });
});
