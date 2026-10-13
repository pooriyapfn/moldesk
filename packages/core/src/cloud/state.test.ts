import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudJournal, cloudResourceName, type NewCloudJob } from "./state.js";

const dirs: string[] = [];
const RUN = "2026-10-13T11-55-45-123Z-0a1b2c3d-1111-2222-3333-444455556666";

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk cloud journal "));
  dirs.push(dir);
  return path.join(dir, "cloud.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function clock(start = "2026-10-13T12:00:00.000Z") {
  let ms = Date.parse(start);
  return { now: () => new Date(ms).toISOString(), advance: (seconds: number) => void (ms += seconds * 1000) };
}

const job: NewCloudJob = {
  runId: RUN,
  accountScope: "acct1",
  quoteDigest: "q".repeat(64),
  cachePolicy: "ephemeral",
  gpuId: "NVIDIA A40",
  datacenterId: "EU-RO-1",
  deadlineAt: "2026-10-13T13:00:00.000Z",
  manifestDigest: "m".repeat(64),
};

describe("CloudJournal", () => {
  it("keeps a stable client id across reopen and rejects a newer schema", () => {
    const file = tempFile();
    const first = CloudJournal.openFile(file);
    const id = first.clientId;
    first.close();
    const second = CloudJournal.openFile(file);
    expect(second.clientId).toBe(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    second.close();
  });

  it("tracks a job through stages and survives reopen", () => {
    const file = tempFile();
    const journal = CloudJournal.openFile(file);
    const created = journal.createJob(job);
    expect(created).toMatchObject({ stage: "approved", status: "active", gpuId: "NVIDIA A40", volumeId: null });
    journal.updateJob(RUN, { stage: "running", volumeId: "vol1", transferState: "none" });
    journal.close();

    const reopened = CloudJournal.openFile(file);
    expect(reopened.getJob(RUN)).toMatchObject({ stage: "running", volumeId: "vol1", transferState: "none" });
    expect(reopened.listOpenJobs().map((j) => j.runId)).toEqual([RUN]);
    reopened.updateJob(RUN, { stage: "done", status: "cleanup_pending", error: { code: "CLOUD_CLEANUP_PENDING", message: "x" } });
    expect(reopened.getJob(RUN)!.error).toEqual({ code: "CLOUD_CLEANUP_PENDING", message: "x" });
    expect(reopened.listOpenJobs()).toHaveLength(1);
    reopened.updateJob(RUN, { status: "succeeded", error: null });
    expect(reopened.listOpenJobs()).toHaveLength(0);
    expect(() => reopened.updateJob("missing", { stage: "done" })).toThrow(/No cloud job/);
    reopened.close();
  });

  it("persists resource intent before the provider call and reconstructs it after a crash", () => {
    const file = tempFile();
    const first = CloudJournal.openFile(file);
    first.createJob(job);
    const intent = first.recordResourceIntent({ runId: RUN, role: "gpu", deadlineAt: job.deadlineAt });
    expect(intent).toMatchObject({ state: "create_pending", providerId: null });
    expect(intent.name).toBe(cloudResourceName(first.clientId, RUN, "gpu"));
    expect(intent.name).toMatch(/^moldesk-[0-9a-f]{8}-0a1b2c3d-gpu$/);
    first.close(); // simulated client crash before the create response

    const second = CloudJournal.openFile(file);
    expect(second.listResources({ states: ["create_pending"] }).map((r) => r.intentId)).toEqual([intent.intentId]);
    const active = second.recordResourceCreated(intent.intentId, "pod1");
    expect(active).toMatchObject({ state: "active", providerId: "pod1" });
    expect(second.findOwnedByProviderId("pod1")?.intentId).toBe(intent.intentId);
    second.markResourceDeletePending(intent.intentId);
    second.markResourceDeleted(intent.intentId);
    expect(second.findOwnedByProviderId("pod1")).toBeUndefined();
    second.close();
  });

  it("rejects illegal resource transitions", () => {
    const journal = CloudJournal.openFile(tempFile());
    const intent = journal.recordResourceIntent({ runId: RUN, role: "volume" });
    journal.markResourceDeleted(intent.intentId);
    expect(() => journal.recordResourceCreated(intent.intentId, "v1")).toThrow(/Cannot move/);
    expect(() => journal.markResourceDeletePending("nope")).toThrow(/No cloud resource/);
    journal.close();
  });

  describe("reconcile", () => {
    it("adopts an ambiguous create that did take effect, matched by exact name", () => {
      const journal = CloudJournal.openFile(tempFile());
      const intent = journal.recordResourceIntent({ runId: RUN, role: "gpu" });
      const report = journal.reconcile([{ providerId: "pod9", name: intent.name, role: "gpu" }]);
      expect(report.adopted.map((r) => r.providerId)).toEqual(["pod9"]);
      expect(journal.getResource(intent.intentId)).toMatchObject({ state: "active", providerId: "pod9" });
      journal.close();
    });

    it("abandons a create that never took effect", () => {
      const journal = CloudJournal.openFile(tempFile());
      const intent = journal.recordResourceIntent({ runId: RUN, role: "gpu" });
      const report = journal.reconcile([]);
      expect(report.abandoned.map((r) => r.intentId)).toEqual([intent.intentId]);
      expect(journal.getResource(intent.intentId)!.state).toBe("deleted");
      journal.close();
    });

    it("marks resources the provider no longer has as vanished", () => {
      const journal = CloudJournal.openFile(tempFile());
      const intent = journal.recordResourceIntent({ runId: RUN, role: "cpu" });
      journal.recordResourceCreated(intent.intentId, "pod1");
      expect(journal.reconcile([]).vanished.map((r) => r.intentId)).toEqual([intent.intentId]);
      expect(journal.getResource(intent.intentId)!.state).toBe("deleted");
      journal.close();
    });

    it("reports, but never adopts, a provider resource that only claims this client by name", () => {
      const journal = CloudJournal.openFile(tempFile());
      const prefix = journal.clientId.replace(/-/g, "").slice(0, 8);
      const lookalike = { providerId: "podX", name: `moldesk-${prefix}-deadbeef-gpu`, role: "gpu" as const };
      const foreign = { providerId: "podY", name: "moldesk-ffffffff-deadbeef-gpu", role: "gpu" as const };
      const unrelated = { providerId: "podZ", name: "my-own-pod", role: "gpu" as const };
      const report = journal.reconcile([lookalike, foreign, unrelated]);
      expect(report.orphaned).toEqual([lookalike]);
      expect(journal.findOwnedByProviderId("podX")).toBeUndefined();
      journal.close();
    });

    it("leaves ambiguous same-name candidates pending and flags them", () => {
      const journal = CloudJournal.openFile(tempFile());
      const intent = journal.recordResourceIntent({ runId: RUN, role: "gpu" });
      const report = journal.reconcile([
        { providerId: "a", name: intent.name, role: "gpu" },
        { providerId: "b", name: intent.name, role: "gpu" },
      ]);
      expect(report.adopted).toHaveLength(0);
      expect(report.orphaned.map((r) => r.providerId).sort()).toEqual(["a", "b"]);
      expect(journal.getResource(intent.intentId)!.state).toBe("create_pending");
      journal.close();
    });

    it("lists owed cleanup: delete_pending and active resources past their deadline", () => {
      const time = clock();
      const journal = CloudJournal.openFile(tempFile(), { now: time.now });
      const pending = journal.recordResourceIntent({ runId: RUN, role: "gpu" });
      journal.recordResourceCreated(pending.intentId, "pod1");
      journal.markResourceDeletePending(pending.intentId);
      const overdue = journal.recordResourceIntent({ runId: RUN, role: "cpu", deadlineAt: "2026-10-13T12:30:00.000Z" });
      journal.recordResourceCreated(overdue.intentId, "pod2");
      const view = (providerId: string, name: string, role: "gpu" | "cpu") => ({ providerId, name, role });
      const listing = [view("pod1", pending.name, "gpu"), view("pod2", overdue.name, "cpu")];

      expect(journal.reconcile(listing).cleanupOwed.map((r) => r.providerId)).toEqual(["pod1"]);
      time.advance(31 * 60);
      expect(journal.reconcile(listing).cleanupOwed.map((r) => r.providerId).sort()).toEqual(["pod1", "pod2"]);
      journal.close();
    });
  });

  describe("caches", () => {
    const key = { accountScope: "acct1", datacenterId: "EU-RO-1", volumeId: "vol1", cacheKey: "k".repeat(64) };
    const base = {
      ...key,
      model: "boltz",
      modelVersion: "2.2.1",
      layoutRevision: "1",
      manifestDigest: "m".repeat(64),
      cachePath: "/workspace/moldesk-cache/k",
      sizeBytes: null,
      checksumManifestDigest: null,
    };

    it("only reaches READY through VERIFYING with a checksum manifest", () => {
      const journal = CloudJournal.openFile(tempFile());
      expect(journal.upsertCache(base).state).toBe("PREPARING");
      expect(() => journal.setCacheState(key, "READY")).toThrow(/Cannot move/);
      journal.setCacheState(key, "VERIFYING");
      expect(() => journal.setCacheState(key, "READY")).toThrow(/checksum manifest/);
      const ready = journal.setCacheState(key, "READY", { sizeBytes: 123, checksumManifestDigest: "c".repeat(64) });
      expect(ready).toMatchObject({ state: "READY", sizeBytes: 123 });
      journal.setCacheState(key, "FAILED");
      expect(journal.setCacheState(key, "PREPARING").state).toBe("PREPARING");
      journal.close();
    });

    it("grants a lease to one owner at a time, allows renewal, and reclaims after expiry", () => {
      const time = clock();
      const journal = CloudJournal.openFile(tempFile(), { now: time.now });
      journal.upsertCache(base);
      expect(journal.acquireCacheLease(key, "a", 60)).toBe(true);
      expect(journal.acquireCacheLease(key, "b", 60)).toBe(false);
      expect(journal.acquireCacheLease(key, "a", 60)).toBe(true); // renewal
      time.advance(61);
      expect(journal.acquireCacheLease(key, "b", 60)).toBe(true);
      journal.releaseCacheLease(key, "a"); // not the owner: no effect
      expect(journal.getCache(key.accountScope, key.datacenterId, key.volumeId, key.cacheKey)!.leaseOwner).toBe("b");
      journal.releaseCacheLease(key, "b");
      expect(journal.acquireCacheLease(key, "a", 60)).toBe(true);
      journal.close();
    });

    it("lists and deletes cache rows", () => {
      const journal = CloudJournal.openFile(tempFile());
      journal.upsertCache(base);
      expect(journal.listCaches()).toHaveLength(1);
      journal.deleteCache(key);
      expect(journal.listCaches()).toHaveLength(0);
      journal.close();
    });
  });
});
