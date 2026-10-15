import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIN_WORKER_READY_TIMEOUT_MS,
  RunpodExecutionBackend,
  WorkerClient,
  type ApprovedJob,
  type BackendContext,
  type CloudCatalog,
  type CloudPod,
  type CloudProvider,
  type CloudVolume,
  type CreatePodRequest,
  type TokenStore,
} from "@moldesk/runtime";
import { cacheLedgerFor } from "./run.js";
import { CloudJournal, type CloudResourceRole } from "./state.js";
import { createWorkerServer, type RunningWorker, type WorkerPipeline } from "./worker/server.js";
import { parseManifest } from "@moldesk/registry";

const DIGEST = "a".repeat(64);
const dirs: string[] = [];
const fleets: Fleet[] = [];

const manifest = parseManifest(
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
    input: { formats: [".txt"], required: true },
    outputs: [{ id: "o", glob: "*.out", required: true }],
    cloud: { schemaVersion: 1, platform: "linux-x64", images: { gpu: `r.example/g@sha256:${DIGEST}`, cpu: `r.example/c@sha256:${DIGEST}` }, minVramGb: 24, minRamGb: 32, ephemeralDiskGb: 40, volumeGb: 40, assetLayoutRevision: "1", cpuAssetPreparation: true },
  },
  "x/manifest.yaml",
);

class Fleet implements CloudProvider {
  readonly name = "runpod";
  log: string[] = [];
  pods = new Map<string, { pod: CloudPod; worker: RunningWorker; endpoint: string; request: CreatePodRequest }>();
  volumes = new Map<string, CloudVolume & { cacheReady: boolean }>();
  nextId = 1;
  gpuAvailable = true;
  /** Extra catalog GPUs besides the default A40. */
  extraGpus: CloudCatalog["gpus"] = [];
  /** GPU ids whose create is rejected for capacity even though the catalog lists them. */
  rejectGpuIds = new Set<string>();
  cpuDiskGbSeen: number[] = [];
  rejectCpuIds = new Set<string>();
  cpuRequests: CreatePodRequest[] = [];
  extraCpus: CloudCatalog["cpus"] = [];
  /** Make the next volume claim `cacheReady` (a warm cache) or not. */
  podStatus: CloudPod["status"] = "RUNNING";
  terminateFails = false;
  /** Set to make GPU workers claim the cache is missing once. */
  forgetCache = false;

  async validateCredentials() {
    return { ok: true as const, checkedAt: "t" };
  }
  async getCatalog(): Promise<CloudCatalog> {
    return {
      retrievedAt: "t",
      gpus: [{ id: "a40", name: "A40", memoryGb: 48, priceUsdPerHour: 0.6, availability: this.gpuAvailable ? "LOW" : "NONE", dataCenters: [{ id: "DC-1", availability: this.gpuAvailable ? "LOW" : "NONE" }], cudaVersions: [] }, ...this.extraGpus],
      cpus: [{ id: "cpu3c", name: "c", priceUsdPerVcpuHour: 0.03, ramGbPerVcpu: 2, minVcpu: 2, maxVcpu: 32 }, ...this.extraCpus],
      dataCenters: [{ id: "DC-1", region: "EU", networkVolumeTypes: ["STANDARD"] }],
    };
  }
  async createVolume(request: { name: string; sizeGb: number; dataCenterId: string }): Promise<CloudVolume> {
    const volume = { id: `vol${this.nextId++}`, name: request.name, sizeGb: request.sizeGb, dataCenterId: request.dataCenterId, type: "STANDARD", cacheReady: false };
    this.volumes.set(volume.id, volume);
    this.log.push(`createVolume ${volume.id}`);
    return volume;
  }
  async createPod(request: CreatePodRequest): Promise<CloudPod> {
    if (request.cpu && this.rejectCpuIds.has(request.cpu.id)) throw Object.assign(new Error("no capacity"), { code: "CLOUD_CAPACITY_UNAVAILABLE" });
    if (request.gpu && this.rejectGpuIds.has(request.gpu.id)) throw Object.assign(new Error("no capacity"), { code: "CLOUD_CAPACITY_UNAVAILABLE" });
    if (request.gpu && !this.gpuAvailable) throw Object.assign(new Error("no capacity"), { code: "CLOUD_CAPACITY_UNAVAILABLE" });
    const id = `pod${this.nextId++}`;
    const role = request.gpu ? "gpu" : "cpu";
    if (!request.gpu) {
      this.cpuDiskGbSeen.push(request.containerDiskGb);
      this.cpuRequests.push(request);
    }
    this.log.push(`createPod ${role} ${id}`);
    const volumeId = request.volume?.id;
    const pipeline: WorkerPipeline = async ({ job, outputDir, log, setStage }) => {
      const volume = volumeId ? this.volumes.get(volumeId) : undefined;
      if (job.mode === "prepare-assets") {
        setStage("preparing_assets");
        volume!.cacheReady = true;
        return { exitCode: 0, runtime: { dependencyFreeze: [], cache: { checksumManifestSha256: "c".repeat(64), sizeBytes: 123, fileCount: 2, reused: false } } };
      }
      setStage("preparing_assets");
      if (volume && (!volume.cacheReady || this.forgetCache)) {
        this.forgetCache = false;
        volume.cacheReady = false;
        throw Object.assign(new Error("no cache"), { code: "CLOUD_CACHE_MISSING" });
      }
      setStage("running");
      log("stdout", "predicting\n");
      fs.writeFileSync(path.join(outputDir, "a.out"), "result");
      return { exitCode: 0, runtime: { dependencyFreeze: ["torch==2"] } };
    };
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk fleet "));
    dirs.push(rootDir);
    const worker = createWorkerServer({ token: request.env!.MOLDESK_WORKER_TOKEN!, rootDir, pipeline });
    const port = await worker.listen(0, "127.0.0.1");
    const pod: CloudPod = { id, name: request.name, status: this.podStatus, dataCenterId: request.dataCenterId, costUsdPerHour: 0.6, createdAt: null };
    this.pods.set(id, { pod, worker, endpoint: `http://127.0.0.1:${port}`, request });
    return pod;
  }
  async getPod(id: string) {
    return this.pods.get(id)?.pod ?? null;
  }
  async listPods() {
    return [...this.pods.values()].map((entry) => entry.pod);
  }
  async terminatePod(id: string) {
    if (this.terminateFails) throw new Error("provider down");
    this.log.push(`terminate ${id}`);
    const entry = this.pods.get(id);
    if (entry) await entry.worker.close();
    this.pods.delete(id);
    return { id, alreadyAbsent: !entry };
  }
  async getVolume(id: string) {
    return this.volumes.get(id) ?? null;
  }
  async listVolumes() {
    return [...this.volumes.values()];
  }
  async deleteVolume(id: string) {
    this.log.push(`deleteVolume ${id}`);
    this.volumes.delete(id);
    return { id, alreadyAbsent: false };
  }
}

function memoryTokens(): TokenStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async set(id, token) { data.set(id, token); }, async get(id) { return data.get(id) ?? null; }, async delete(id) { data.delete(id); } };
}

function setup(overrides: { bundle?: boolean } = {}) {
  const fleet = new Fleet();
  fleets.push(fleet);
  const tokens = memoryTokens();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk backend "));
  dirs.push(home);
  const journal = CloudJournal.openFile(path.join(home, "j.sqlite"));
  const backend = new RunpodExecutionBackend({
    provider: fleet,
    tokenStore: tokens,
    ...(overrides.bundle === false ? {} : { workerBundle: { url: "https://example.com/worker.tgz", sha256: "d".repeat(64) } }),
    endpointFor: (id) => fleet.pods.get(id)!.endpoint,
    createClient: (endpoint, token) => new WorkerClient({ endpoint, token, allowInsecureLoopback: true, sleep: async () => undefined }),
    sleep: async () => undefined,
    terminationWaitMs: 100,
    pollIntervalMs: 1,
  });
  const runId = (n: number) => `2026-10-13T11-55-45-123Z-0a1b2c3d-1111-2222-3333-44445555666${n}`;
  const inputPath = path.join(home, "in.txt");
  fs.writeFileSync(inputPath, "job");
  const job = (n: number, patch: Partial<ApprovedJob> = {}): ApprovedJob => ({
    version: 1,
    runId: runId(n),
    model: "m",
    modelVersion: "1.0.0",
    manifestDigest: "md",
    cachePolicy: "ephemeral",
    gpuId: "a40",
    datacenterId: "DC-1",
    gpuPolicy: { minVramGb: 24, maxUsdPerHour: 1.2, lockDatacenter: false },
    images: manifest.cloud!.images,
    containerDiskGb: 40,
    volumeGb: 40,
    assetLayoutRevision: "1",
    cpuAssetPreparation: true,
    cacheKey: "k".repeat(64),
    params: {},
    inputs: [{ role: "job", relativePath: "in.txt", sha256: "3f7b3f21d1d8f2fe8f9f3a3dc5f0c0ca7c3fbb5e0cf0c7f9ad7f3b4d5d9c3d3c", sizeBytes: 3, sourcePath: inputPath }],
    deadlineAt: "2099-01-01T00:00:00.000Z",
    ...patch,
  });
  // Real sha so the worker's upload verification passes.
  const realSha = require("node:crypto").createHash("sha256").update("job").digest("hex") as string;
  const ctx = (n: number, persistent: boolean): BackendContext => ({
    ledger: {
      beginCreate: (role) => {
        const intent = journal.recordResourceIntent({ ...(role === "volume" ? {} : { runId: runId(n) }), role: role as CloudResourceRole, deadlineAt: "2099-01-01T00:00:00.000Z" });
        return { intentId: intent.intentId, name: intent.name };
      },
      created: (intentId, providerId) => void journal.recordResourceCreated(intentId, providerId),
      beginDelete: (intentId) => void journal.markResourceDeletePending(intentId),
      deleted: (intentId) => void journal.markResourceDeleted(intentId),
    },
    ...(persistent ? { cache: cacheLedgerFor(journal, { accountScope: "acct", runId: runId(n), manifest, cloud: manifest.cloud!, cacheKey: "k".repeat(64), manifestDigest: "md" }) } : {}),
  });
  const withSha = (j: ApprovedJob): ApprovedJob => ({ ...j, inputs: j.inputs.map((file) => ({ ...file, sha256: realSha })) });
  return { fleet, tokens, journal, backend, job: (n: number, patch: Partial<ApprovedJob> = {}) => withSha(job(n, patch)), ctx, runId };
}

async function finish(backend: RunpodExecutionBackend, handle: Awaited<ReturnType<RunpodExecutionBackend["start"]>>) {
  for (let i = 0; i < 400; i += 1) {
    const snapshot = await backend.observe(handle);
    if (snapshot.state !== "running") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("did not finish");
}

afterEach(async () => {
  for (const fleet of fleets.splice(0)) for (const entry of fleet.pods.values()) await entry.worker.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("RunpodExecutionBackend (ephemeral)", () => {
  it("provisions a GPU pod, uploads, runs, collects and terminates with confirmation", async () => {
    const box = setup();
    const handle = await box.backend.start(box.job(1), box.ctx(1, false));
    expect(box.fleet.pods.get(handle.podId)!.request).toMatchObject({
      image: manifest.cloud!.images.gpu,
      gpu: { id: "a40", count: 1 },
      ports: ["8000/http"],
      entrypoint: ["/bin/bash", "-c"],
    });
    expect(box.fleet.pods.get(handle.podId)!.request.env).toMatchObject({ MOLDESK_WORKER_DEADLINE_AT: "2099-01-01T00:00:00.000Z", MOLDESK_WORKER_BUNDLE_SHA256: "d".repeat(64) });
    expect(box.tokens.data.get(handle.runId)).toMatch(/^[0-9a-f]{64}$/);
    expect((await finish(box.backend, handle)).state).toBe("succeeded");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk out "));
    dirs.push(out);
    await box.backend.collect(handle, out);
    expect(fs.readFileSync(path.join(out, "a.out"), "utf8")).toBe("result");

    await box.backend.release(handle, box.ctx(1, false));
    expect(box.fleet.pods.size).toBe(0);
    expect(box.tokens.data.size).toBe(0);
    expect(box.journal.listResources({ states: ["create_pending", "active", "delete_pending"] })).toHaveLength(0);
  });

  const gpu = (id: string, price: number, memoryGb = 48, dc = "DC-1"): CloudCatalog["gpus"][number] => ({ id, name: id, memoryGb, priceUsdPerHour: price, availability: "LOW", dataCenters: [{ id: dc, availability: "LOW" }], cudaVersions: [] });

  it("falls back to the next available GPU in the price range when the first rejects for capacity, and reports what it got", async () => {
    const box = setup();
    box.fleet.extraGpus = [gpu("l40", 0.9), gpu("h100", 3), gpu("small", 0.2, 16)];
    box.fleet.rejectGpuIds.add("a40");
    const handle = await box.backend.start(box.job(1), box.ctx(1, false));
    expect(handle).toMatchObject({ gpuId: "l40", datacenterId: "DC-1" });
    expect([...box.fleet.pods.values()].map((entry) => entry.request.gpu?.id)).toEqual(["l40"]);
    // The rejected attempt left no orphaned journal intent.
    await box.backend.release(handle, box.ctx(1, false));
    expect(box.journal.listResources({ states: ["create_pending", "active", "delete_pending"] })).toHaveLength(0);
  });

  it("never uses a GPU over the approved price or under the VRAM floor, and fails with guidance when none is left", async () => {
    const box = setup();
    box.fleet.extraGpus = [gpu("h100", 3), gpu("small", 0.2, 16)];
    box.fleet.rejectGpuIds.add("a40");
    await expect(box.backend.start(box.job(1), box.ctx(1, false))).rejects.toMatchObject({ code: "CLOUD_CAPACITY_UNAVAILABLE" });
    expect(box.fleet.pods.size).toBe(0);
    expect(box.journal.listResources({ states: ["create_pending", "active", "delete_pending"] })).toHaveLength(0);
  });

  it("substitutes nothing when the user pinned a GPU", async () => {
    const box = setup();
    box.fleet.extraGpus = [gpu("l40", 0.9)];
    box.fleet.rejectGpuIds.add("a40");
    await expect(box.backend.start(box.job(1, { gpuPolicy: { minVramGb: 24, maxUsdPerHour: 1.2, pinnedGpuId: "a40", lockDatacenter: false } }), box.ctx(1, false))).rejects.toMatchObject({ code: "CLOUD_CAPACITY_UNAVAILABLE" });
  });

  it("only tries GPUs on the manifest's allow-list, whatever else the price range admits", async () => {
    const box = setup();
    box.fleet.extraGpus = [gpu("l40", 0.9)];
    const handle = await box.backend.start(box.job(1, { gpuPolicy: { minVramGb: 24, maxUsdPerHour: 1.2, allowedGpuIds: ["l40"], lockDatacenter: false } }), box.ctx(1, false));
    const used = [...box.fleet.pods.values()].map((entry) => entry.request.gpu?.id);
    await box.backend.release(handle, box.ctx(1, false));
    expect(used).toEqual(["l40"]);

    const refused = setup();
    refused.fleet.rejectGpuIds.add("l40");
    refused.fleet.extraGpus = [gpu("l40", 0.9)];
    await expect(refused.backend.start(refused.job(1, { gpuPolicy: { minVramGb: 24, maxUsdPerHour: 1.2, allowedGpuIds: ["l40"], lockDatacenter: false } }), refused.ctx(1, false))).rejects.toMatchObject({ code: "CLOUD_CAPACITY_UNAVAILABLE" });
    expect(refused.fleet.pods.size).toBe(0);
  });

  it("keeps the CPU preparation pod's container disk within Runpod's 20 GB limit", async () => {
    const box = setup();
    const handle = await box.backend.start(box.job(1, { cachePolicy: "persistent", containerDiskGb: 60 }), box.ctx(1, true));
    const requests = [...box.fleet.pods.values()].map((entry) => entry.request);
    await box.backend.release(handle, box.ctx(1, true));
    expect(box.fleet.log.filter((line) => line.startsWith("createPod cpu"))).toHaveLength(1);
    expect(box.fleet.cpuDiskGbSeen).toEqual([20]);
    expect(requests.find((request) => request.gpu)!.containerDiskGb).toBe(60);
  });

  it("prepares on the next available CPU type when the first rejects for capacity", async () => {
    const box = setup();
    box.fleet.extraCpus = [{ id: "cpu5c", name: "c5", priceUsdPerVcpuHour: 0.035, ramGbPerVcpu: 2, minVcpu: 2, maxVcpu: 32 }, { id: "cpu5m", name: "mem", priceUsdPerVcpuHour: 0.065, ramGbPerVcpu: 8, minVcpu: 2, maxVcpu: 32 }];
    box.fleet.rejectCpuIds.add("cpu3c");
    const handle = await box.backend.start(box.job(1, { cachePolicy: "persistent", cpuPolicy: { maxUsdPerHour: 0.2 } }), box.ctx(1, true));
    const cpuRequests = box.fleet.cpuRequests;
    await box.backend.release(handle, box.ctx(1, true));
    // cpu5c is used (cheaper than the rejected cpu3c's fallback and never the memory-optimized type).
    expect(cpuRequests.map((request) => request.cpu!.id)).toEqual(["cpu5c"]);
  });

  it("rebuilds into the volume a failed preparation left behind instead of creating another", async () => {
    const box = setup();
    box.fleet.rejectCpuIds.add("cpu3c");
    await expect(box.backend.start(box.job(1, { cachePolicy: "persistent" }), box.ctx(1, true))).rejects.toMatchObject({ code: "CLOUD_CAPACITY_UNAVAILABLE" });
    expect(box.fleet.volumes.size).toBe(1);
    expect(box.journal.listCaches()[0]!.state).toBe("FAILED");
    box.fleet.rejectCpuIds.clear();
    const handle = await box.backend.start(box.job(2, { cachePolicy: "persistent" }), box.ctx(2, true));
    await box.backend.release(handle, box.ctx(2, true));
    expect(box.fleet.volumes.size).toBe(1);
    expect(box.fleet.log.filter((line) => line.startsWith("createVolume"))).toHaveLength(1);
    expect(box.journal.listCaches()[0]!.state).toBe("READY");
  });

  it("refuses to start without a configured worker bundle and creates nothing", async () => {
    const box = setup({ bundle: false });
    await expect(box.backend.start(box.job(1), box.ctx(1, false))).rejects.toMatchObject({ code: "CLOUD_WORKER_BUNDLE_UNCONFIGURED" });
    expect(box.fleet.log).toEqual([]);
  });

  it("stops waiting and surfaces a boot failure when the pod enters ERROR, leaving it releasable", async () => {
    const box = setup();
    box.fleet.podStatus = "ERROR";
    // Make the worker unreachable so readiness polling consults the pod status.
    const original = box.fleet.createPod.bind(box.fleet);
    box.fleet.createPod = async (request) => {
      const pod = await original(request);
      await box.fleet.pods.get(pod.id)!.worker.close();
      return pod;
    };
    await expect(box.backend.start(box.job(1), box.ctx(1, false))).rejects.toMatchObject({ code: "CLOUD_WORKER_BOOT_FAILED" });
    await box.backend.release({ runId: box.job(1).runId }, box.ctx(1, false));
    expect(box.fleet.pods.size).toBe(0);
  });

  it("does not mark a pod deleted when the provider cannot terminate it", async () => {
    const box = setup();
    const handle = await box.backend.start(box.job(1), box.ctx(1, false));
    box.fleet.terminateFails = true;
    await box.backend.release(handle, box.ctx(1, false));
    expect(box.fleet.pods.size).toBe(1);
    expect(box.journal.listResources({ states: ["delete_pending"] })).toHaveLength(1);
  });

  it("clamps the readiness timeout to at least five minutes", () => {
    expect(MIN_WORKER_READY_TIMEOUT_MS).toBe(300_000);
  });
});

describe("RunpodExecutionBackend (persistent)", () => {
  const persistent = { cachePolicy: "persistent" as const };

  it("cold: prepares on CPU, terminates the CPU pod before any GPU exists, retains the volume, marks the cache READY", async () => {
    const box = setup();
    const handle = await box.backend.start(box.job(1, persistent), box.ctx(1, true));
    expect(box.fleet.log).toEqual(["createVolume vol1", "createPod cpu pod2", "terminate pod2", expect.stringMatching(/^createPod gpu pod3$/)]);
    expect(handle.volumeId).toBe("vol1");
    expect((await finish(box.backend, handle)).state).toBe("succeeded");
    await box.backend.release(handle, box.ctx(1, true));
    expect(box.fleet.pods.size).toBe(0);
    expect(box.fleet.volumes.has("vol1")).toBe(true); // volume survives ordinary cleanup
    expect(box.fleet.log).not.toContain("deleteVolume vol1");
    const cache = box.journal.listCaches()[0]!;
    expect(cache).toMatchObject({ state: "READY", volumeId: "vol1", sizeBytes: 123, checksumManifestDigest: "c".repeat(64), leaseOwner: null });
  });

  it("warm: a second run reuses the volume with zero CPU pods and no new volume", async () => {
    const box = setup();
    const first = await box.backend.start(box.job(1, persistent), box.ctx(1, true));
    await finish(box.backend, first);
    await box.backend.release(first, box.ctx(1, true));
    box.fleet.log.length = 0;

    const second = await box.backend.start(box.job(2, persistent), box.ctx(2, true));
    expect(box.fleet.log).toEqual([expect.stringMatching(/^createPod gpu /)]);
    expect((await finish(box.backend, second)).state).toBe("succeeded");
    await box.backend.release(second, box.ctx(2, true));
    expect(box.fleet.volumes.size).toBe(1);
  });

  it("warm but the volume lost its cache: the GPU pod is dropped, the CPU rebuilds it, then a fresh GPU runs", async () => {
    const box = setup();
    const first = await box.backend.start(box.job(1, persistent), box.ctx(1, true));
    await finish(box.backend, first);
    await box.backend.release(first, box.ctx(1, true));
    box.fleet.log.length = 0;
    box.fleet.forgetCache = true;

    const second = await box.backend.start(box.job(2, persistent), box.ctx(2, true));
    expect(box.fleet.log.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["createPod gpu", "terminate pod4", "createPod cpu", "terminate pod5", "createPod gpu"].map((line, index) => (index === 1 || index === 3 ? line.split(" ").slice(0, 2).join(" ") : line)));
    expect((await finish(box.backend, second)).state).toBe("succeeded");
    expect(box.journal.listCaches()[0]!.state).toBe("READY");
    await box.backend.release(second, box.ctx(2, true));
    expect(box.fleet.pods.size).toBe(0);
  });

  it("loses GPU capacity after preparation: the CPU pod is gone, the volume and READY cache are retained, with guidance", async () => {
    const box = setup();
    const originalCatalog = box.fleet.getCatalog.bind(box.fleet);
    box.fleet.getCatalog = async () => {
      const catalog = await originalCatalog();
      return box.fleet.log.some((line) => line.startsWith("terminate")) ? { ...catalog, gpus: catalog.gpus.map((gpu) => ({ ...gpu, availability: "NONE" as const, dataCenters: [] })) } : catalog;
    };
    await expect(box.backend.start(box.job(1, persistent), box.ctx(1, true))).rejects.toMatchObject({ code: "CLOUD_CAPACITY_UNAVAILABLE" });
    expect(box.fleet.pods.size).toBe(0);
    expect(box.fleet.volumes.has("vol1")).toBe(true);
    expect(box.journal.listCaches()[0]!.state).toBe("READY");
    expect(box.fleet.log.filter((line) => line.startsWith("createPod gpu"))).toHaveLength(0);
  });

  it("refuses to prepare while another process holds the cache lease", async () => {
    const box = setup();
    const context = box.ctx(1, true);
    context.cache!.begin({ volumeId: "volX", datacenterId: "DC-1" });
    expect(box.journal.acquireCacheLease({ accountScope: "acct", datacenterId: "DC-1", volumeId: "volX", cacheKey: "k".repeat(64) }, "someone-else", 600)).toBe(true);
    const job = box.job(1, { ...persistent, reuseVolumeId: "volX" });
    await expect(box.backend.start(job, context)).rejects.toMatchObject({ code: "CLOUD_CACHE_LOCKED" });
    expect(box.fleet.pods.size).toBe(0);
  });

  it("terminates the CPU pod even when preparation fails and leaves the cache FAILED, never READY", async () => {
    const box = setup();
    const originalCreate = box.fleet.createPod.bind(box.fleet);
    box.fleet.createPod = async (request) => {
      const pod = await originalCreate(request);
      if (!request.gpu) {
        const entry = box.fleet.pods.get(pod.id)!;
        await entry.worker.close();
        const volumeId = request.volume!.id;
        const worker = createWorkerServer({
          token: request.env!.MOLDESK_WORKER_TOKEN!,
          rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "moldesk fail ")),
          pipeline: async () => {
            void volumeId;
            throw Object.assign(new Error("disk full"), { code: "CLOUD_ASSET_PREPARATION_FAILED" });
          },
        });
        const port = await worker.listen(0, "127.0.0.1");
        box.fleet.pods.set(pod.id, { ...entry, worker, endpoint: `http://127.0.0.1:${port}` });
      }
      return pod;
    };
    await expect(box.backend.start(box.job(1, persistent), box.ctx(1, true))).rejects.toMatchObject({ code: "CLOUD_ASSET_PREPARATION_FAILED" });
    expect(box.fleet.pods.size).toBe(0);
    expect(box.journal.listCaches()[0]!.state).toBe("FAILED");
    expect(box.fleet.log.filter((line) => line.startsWith("createPod gpu"))).toHaveLength(0);
  });
});
