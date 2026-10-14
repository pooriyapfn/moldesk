import { randomBytes } from "node:crypto";
import { MoldeskError } from "../providers.js";
import { createKeyringBackend, type SecretBackend } from "./credentials.js";
import {
  EXECUTION_CONTRACT_VERSION,
  WORKER_PORT,
  toWireJob,
  type ApprovedJob,
  type ArtifactInventory,
  type BackendContext,
  type ExecutionBackend,
  type JobHandle,
  type JobSnapshot,
} from "./execution.js";
import type { CloudPod, CloudProvider } from "./types.js";
import { WorkerClient } from "./worker-client.js";

export const MIN_WORKER_READY_TIMEOUT_MS = 5 * 60_000;
/** Runpod rejects CPU Pods with a container disk above this (live-verified: "Container Disk must be less than or equal to 20"). */
export const CPU_POD_MAX_CONTAINER_DISK_GB = 20;
export const VOLUME_MOUNT = "/workspace";
const TOKEN_SERVICE = "moldesk-worker";

export interface WorkerBundle {
  /** HTTPS URL of the release-pinned worker bundle (a .tar.gz containing `worker/main.js`). */
  url: string;
  sha256: string;
}

/** Per-job reconnect tokens belong in the OS credential store, never in the journal or run record. */
export interface TokenStore {
  set(runId: string, token: string): Promise<void>;
  get(runId: string): Promise<string | null>;
  delete(runId: string): Promise<void>;
}

export function createKeyringTokenStore(backend: SecretBackend = createKeyringBackend()): TokenStore {
  return {
    set: (runId, token) => backend.set(TOKEN_SERVICE, runId, token),
    get: (runId) => backend.get(TOKEN_SERVICE, runId),
    delete: async (runId) => void (await backend.delete(TOKEN_SERVICE, runId)),
  };
}

/**
 * Container start command: fetch the pinned bundle, verify its checksum, and run it. The image must
 * provide Node 20+, curl, tar and sha256sum. Nothing here comes from the user's input.
 */
/** Pinned Node.js used when the worker image has none (stock CUDA/PyTorch images are Python images). */
export const BOOTSTRAP_NODE = {
  version: "20.18.1",
  url: "https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.gz",
  sha256: "259e5a8bf2e15ecece65bd2a47153262eda71c0b2c9700d5e703ce4951572784",
} as const;

export const WORKER_BOOTSTRAP_SCRIPT = [
  "set -euo pipefail",
  'need() { command -v "$1" >/dev/null 2>&1; }',
  // Preflight: fail fast, before any download, with a message that names what the image lacks.
  'if ! need curl; then (apt-get update -qq && apt-get install -y -qq curl ca-certificates) >&2 || { echo "curl is required in the worker image" >&2; exit 127; }; fi',
  'for tool in tar sha256sum; do need "$tool" || { echo "$tool is required in the worker image" >&2; exit 127; }; done',
  'if [ "${MOLDESK_WORKER_ROLE:-}" = gpu ] && ! need nvidia-smi; then echo "nvidia-smi not found: the GPU image must provide the NVIDIA driver tools and CUDA" >&2; exit 127; fi',
  `if ! need node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then`,
  "  mkdir -p /opt/node",
  `  curl -fsSL "${BOOTSTRAP_NODE.url}" -o /opt/node/node.tgz`,
  `  echo "${BOOTSTRAP_NODE.sha256}  /opt/node/node.tgz" | sha256sum -c -`,
  "  tar -xzf /opt/node/node.tgz -C /opt/node --strip-components=1",
  '  export PATH="/opt/node/bin:$PATH"',
  "fi",
  "mkdir -p /opt/moldesk && cd /opt/moldesk",
  'curl -fsSL "$MOLDESK_WORKER_BUNDLE_URL" -o worker.tar',
  'echo "$MOLDESK_WORKER_BUNDLE_SHA256  worker.tar" | sha256sum -c -',
  "tar -xf worker.tar",
  "export MOLDESK_MODELS_DIR=/opt/moldesk/worker/models",
  "exec node worker/main.js",
].join("\n");

export interface RunpodBackendOptions {
  provider: CloudProvider;
  tokenStore: TokenStore;
  workerBundle?: WorkerBundle;
  /** Builds the worker's HTTPS endpoint for a Pod. Defaults to Runpod's proxy. */
  endpointFor?: (podId: string) => string;
  createClient?: (endpoint: string, token: string) => WorkerClient;
  sleep?: (ms: number) => Promise<void>;
  /** Clamped to at least 5 minutes: cold image pulls were observed taking ~100 s or more. */
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Persistent: how long to wait for a terminated CPU Pod to disappear before the GPU Pod starts. */
  terminationWaitMs?: number;
  /** Test hook. */
  now?: () => number;
}

interface TrackedPod {
  intentId: string;
  podId?: string;
}

function backendError(code: string, message: string, remediation: string, details?: Record<string, unknown>, cause?: unknown): MoldeskError {
  return new MoldeskError({ code, message, remediation, details, cause });
}

function isCapacityError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "CLOUD_CAPACITY_UNAVAILABLE";
}

export class RunpodExecutionBackend implements ExecutionBackend {
  private readonly clients = new Map<string, WorkerClient>();
  private readonly tracked = new Map<string, TrackedPod[]>();
  /** Intents already confirmed deleted, so release() stays idempotent. */
  private readonly deletedIntents = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readyTimeoutMs: number;

  constructor(private readonly options: RunpodBackendOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.readyTimeoutMs = Math.max(options.readyTimeoutMs ?? 10 * 60_000, MIN_WORKER_READY_TIMEOUT_MS);
  }

  private endpoint(podId: string): string {
    return (this.options.endpointFor ?? ((id) => `https://${id}-${WORKER_PORT}.proxy.runpod.net`))(podId);
  }

  private client(endpoint: string, token: string): WorkerClient {
    return (this.options.createClient ?? ((url, secret) => new WorkerClient({ endpoint: url, token: secret })))(endpoint, token);
  }

  private async clientFor(handle: JobHandle): Promise<WorkerClient> {
    const cached = this.clients.get(handle.runId);
    if (cached) return cached;
    const token = await this.options.tokenStore.get(handle.runId);
    if (!token) throw backendError("CLOUD_WORKER_TOKEN_MISSING", "The worker token for this run is not in the credential store.", "Results can no longer be fetched through this client; the Pod will be terminated.");
    const created = this.client(handle.endpoint, token);
    this.clients.set(handle.runId, created);
    return created;
  }

  async start(job: ApprovedJob, context: BackendContext): Promise<JobHandle> {
    if (!this.options.workerBundle) {
      throw backendError("CLOUD_WORKER_BUNDLE_UNCONFIGURED", "No worker release bundle is configured.", "Cloud execution needs a published, checksummed worker bundle; none is configured in this build.");
    }
    if (job.cachePolicy === "ephemeral") return (await this.startGpu(job, context, undefined)).handle!;
    return this.startPersistent(job, context);
  }

  private async startPersistent(job: ApprovedJob, context: BackendContext): Promise<JobHandle> {
    const cache = context.cache;
    if (!cache) throw backendError("CLOUD_CACHE_LEDGER_MISSING", "Persistent runs need a cache journal.", "This is an internal error.");
    const known = cache.lookup();
    let volumeId = job.reuseVolumeId ?? known?.volumeId;
    let warm = known !== undefined;

    if (!volumeId) {
      // Do not create (and bill for) a volume in a datacenter where no GPU in range can be had.
      if ((await this.gpuCandidates(job)).length === 0) {
        throw backendError(
          "CLOUD_CAPACITY_UNAVAILABLE",
          `No GPU within the approved price range currently has capacity in ${job.datacenterId}; nothing was created.`,
          "Retry later or raise --max-gpu-price. Capacity is never reserved by a quote.",
        );
      }
      const intent = context.ledger.beginCreate("volume");
      const volume = await this.options.provider.createVolume({ name: intent.name, sizeGb: job.volumeGb, dataCenterId: job.datacenterId });
      context.ledger.created(intent.intentId, volume.id);
      volumeId = volume.id;
      cache.begin({ volumeId, datacenterId: job.datacenterId });
      warm = false;
    }

    if (warm) {
      // Warm: the GPU Pod verifies the volume's cache itself; local READY alone is never trusted.
      context.onProgress?.({ stage: "provisioning", message: "Reusing retained volume" });
      const attempt = await this.startGpu(job, context, volumeId, { watchCacheFailure: true });
      if (attempt.handle) return attempt.handle;
      cache.failed();
      context.onProgress?.({ stage: "preparing_assets", message: "Cache missing or invalid; rebuilding on a CPU machine" });
    }

    await this.prepareOnCpu(job, context, volumeId, cache);
    const handle = await this.startGpu(job, context, volumeId);
    return handle.handle!;
  }

  /** Cold path: CPU Pod prepares the volume, is terminated and confirmed gone, then capacity is rechecked. */
  private async prepareOnCpu(job: ApprovedJob, context: BackendContext, volumeId: string, cache: NonNullable<BackendContext["cache"]>): Promise<void> {
    if (!cache.acquireLease(3600)) {
      throw backendError("CLOUD_CACHE_LOCKED", "Another process in this installation is preparing this cache.", "Wait for it to finish.");
    }
    let cpuPodId: string | undefined;
    let cpuIntent: string | undefined;
    try {
      cache.begin({ volumeId, datacenterId: job.datacenterId });
      context.onProgress?.({ stage: "provisioning", message: "Starting CPU machine to prepare model assets" });
      const token = randomBytes(32).toString("hex");
      const runId = `${job.runId}-prep`;
      await this.options.tokenStore.set(runId, token);
      const pod = await this.createWorkerPod(job, context, { role: "cpu", volumeId, token });
      cpuPodId = pod.pod.id;
      cpuIntent = pod.intentId;
      const client = this.client(this.endpoint(pod.pod.id), token);
      await client.waitUntilReady({ timeoutMs: this.readyTimeoutMs, intervalMs: this.options.pollIntervalMs, signal: context.signal, abortIf: () => this.podFatal(pod.pod.id) });
      await client.start({ ...toWireJob({ ...job, inputs: [] }, { mode: "prepare-assets", volumeMount: VOLUME_MOUNT }), runId });
      const snapshot = await this.waitForTerminal(client, runId, context);
      if (snapshot.state !== "succeeded" || !snapshot.runtime?.cache) {
        cache.failed();
        throw backendError(snapshot.error?.code ?? "CLOUD_ASSET_PREPARATION_FAILED", snapshot.error?.message ?? "Asset preparation failed on the CPU machine.", "The volume cache is not marked ready; retry.");
      }
      cache.verifying();
      cache.ready({ sizeBytes: snapshot.runtime.cache.sizeBytes, checksumManifestDigest: snapshot.runtime.cache.checksumManifestSha256 });
      await this.options.tokenStore.delete(runId).catch(() => undefined);
    } catch (error) {
      cache.failed();
      throw error;
    } finally {
      // Terminate and confirm the CPU Pod before any GPU is requested, whatever happened.
      if (cpuPodId && cpuIntent) await this.terminateAndConfirm(cpuPodId, cpuIntent, context);
      cache.releaseLease();
    }

    // No capacity is reserved by the quote: re-check before renting the GPU. Any GPU in range counts.
    const candidates = await this.gpuCandidates(job);
    if (candidates.length === 0) {
      throw backendError(
        "CLOUD_CAPACITY_UNAVAILABLE",
        `No GPU within the approved price range currently has capacity in ${job.datacenterId}. The prepared volume is retained.`,
        "Retry later; the cache is ready and the next run will skip preparation. Delete the volume with `moldesk cloud cache delete` if you no longer want it.",
      );
    }
  }

  /**
   * Currently available (GPU, datacenter) pairs the approved quote allows, cheapest first, then by
   * reported availability. Re-read from the catalog on every call: capacity is never reserved.
   */
  private async gpuCandidates(job: ApprovedJob): Promise<Array<{ gpuId: string; datacenterId: string; priceUsdPerHour: number }>> {
    const catalog = await this.options.provider.getCatalog();
    const dcById = new Map(catalog.dataCenters.map((dc) => [dc.id, dc]));
    const persistent = job.cachePolicy === "persistent";
    const rank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, UNKNOWN: 3 };
    const pairs: Array<{ gpuId: string; datacenterId: string; priceUsdPerHour: number; availability: string }> = [];
    for (const gpu of catalog.gpus) {
      if (job.gpuPolicy.pinnedGpuId && gpu.id !== job.gpuPolicy.pinnedGpuId) continue;
      if (gpu.memoryGb < job.gpuPolicy.minVramGb || gpu.priceUsdPerHour <= 0 || gpu.priceUsdPerHour > job.gpuPolicy.maxUsdPerHour) continue;
      for (const dc of gpu.dataCenters) {
        if (dc.availability === "NONE") continue;
        if (job.gpuPolicy.lockDatacenter && dc.id !== job.datacenterId) continue;
        if (persistent && (dcById.get(dc.id)?.networkVolumeTypes.length ?? 0) === 0) continue;
        pairs.push({ gpuId: gpu.id, datacenterId: dc.id, priceUsdPerHour: gpu.priceUsdPerHour, availability: dc.availability });
      }
    }
    pairs.sort((a, b) => a.priceUsdPerHour - b.priceUsdPerHour || (rank[a.availability] ?? 3) - (rank[b.availability] ?? 3));
    return pairs.map(({ gpuId, datacenterId, priceUsdPerHour }) => ({ gpuId, datacenterId, priceUsdPerHour }));
  }

  private async createWorkerPod(
    job: ApprovedJob,
    context: BackendContext,
    params: { role: "cpu" | "gpu"; volumeId?: string; token: string; placement?: { gpuId: string; datacenterId: string } },
  ): Promise<{ pod: CloudPod; intentId: string }> {
    const intent = context.ledger.beginCreate(params.role);
    const tracked = this.tracked.get(job.runId) ?? [];
    const entry: TrackedPod = { intentId: intent.intentId };
    tracked.push(entry);
    this.tracked.set(job.runId, tracked);
    const gpuId = params.placement?.gpuId ?? job.gpuId;
    const dataCenterId = params.placement?.datacenterId ?? job.datacenterId;
    let pod: CloudPod;
    try {
      pod = await this.createPodRequest(job, params, intent.name, gpuId, dataCenterId);
    } catch (error) {
      // A definite capacity rejection means nothing was created: close the intent so it is not an orphan.
      if (isCapacityError(error)) {
        context.ledger.beginDelete(intent.intentId);
        context.ledger.deleted(intent.intentId);
        tracked.splice(tracked.indexOf(entry), 1);
      }
      throw error;
    }
    context.ledger.created(intent.intentId, pod.id);
    entry.podId = pod.id;
    return { pod, intentId: intent.intentId };
  }

  private createPodRequest(job: ApprovedJob, params: { role: "cpu" | "gpu"; volumeId?: string; token: string }, name: string, gpuId: string, dataCenterId: string): Promise<CloudPod> {
    const bundle = this.options.workerBundle!;
    return this.options.provider.createPod({
      name,
      image: params.role === "gpu" ? job.images.gpu : job.images.cpu,
      containerDiskGb: params.role === "cpu" ? Math.min(job.containerDiskGb, CPU_POD_MAX_CONTAINER_DISK_GB) : job.containerDiskGb,
      dataCenterId,
      ...(params.role === "gpu" ? { gpu: { id: gpuId, count: 1 } } : { cpu: { id: "cpu3c", vcpuCount: 2 } }),
      ...(params.volumeId ? { volume: { id: params.volumeId, mountPath: VOLUME_MOUNT } } : {}),
      ports: [`${WORKER_PORT}/http`],
      env: {
        MOLDESK_WORKER_TOKEN: params.token,
        MOLDESK_WORKER_ROLE: params.role,
        MOLDESK_WORKER_DEADLINE_AT: job.deadlineAt,
        MOLDESK_WORKER_PORT: String(WORKER_PORT),
        MOLDESK_WORKER_ROOT: "/job",
        MOLDESK_WORKER_BUNDLE_URL: bundle.url,
        MOLDESK_WORKER_BUNDLE_SHA256: bundle.sha256,
      },
      entrypoint: ["/bin/bash", "-c"],
      cmd: [WORKER_BOOTSTRAP_SCRIPT],
    });
  }

  /** Returns a reason string when the Pod can never serve (so booting should stop waiting). */
  private async podFatal(podId: string): Promise<string | undefined> {
    const pod = await this.options.provider.getPod(podId).catch(() => undefined);
    if (pod === null) return "The Pod disappeared before the worker started.";
    if (pod && (pod.status === "ERROR" || pod.status === "EXITED" || pod.status === "TERMINATED")) return `The Pod entered ${pod.status} before the worker started.`;
    return undefined;
  }

  private async waitForTerminal(client: WorkerClient, runId: string, context: BackendContext): Promise<JobSnapshot> {
    let after = 0;
    for (;;) {
      if (context.signal?.aborted) {
        await client.cancel(runId).catch(() => undefined);
        throw backendError("RUN_CANCELLED", "Cancelled.", "None.");
      }
      const snapshot = await client.status(runId, after);
      after = snapshot.logs.cursor;
      if (snapshot.state === "succeeded" || snapshot.state === "failed" || snapshot.state === "cancelled") return snapshot;
      await this.sleep(this.options.pollIntervalMs ?? 5000);
    }
  }

  /**
   * Tries every currently available GPU within the approved range, cheapest first, until one accepts
   * the create. A capacity rejection moves on to the next candidate; any other failure stops.
   */
  private async createGpuPod(
    job: ApprovedJob,
    context: BackendContext,
    volumeId: string | undefined,
    token: string,
  ): Promise<{ pod: CloudPod; intentId: string; placement: { gpuId: string; datacenterId: string } }> {
    const candidates = await this.gpuCandidates(job);
    if (candidates.length === 0) {
      throw backendError(
        "CLOUD_CAPACITY_UNAVAILABLE",
        `No GPU with at least ${job.gpuPolicy.minVramGb} GB VRAM within $${job.gpuPolicy.maxUsdPerHour}/h currently has capacity${job.gpuPolicy.lockDatacenter ? ` in ${job.datacenterId}` : ""}.`,
        "Retry later, raise --max-gpu-price, or relax --gpu/--datacenter. Capacity is never reserved by a quote.",
      );
    }
    let last: unknown;
    for (const candidate of candidates) {
      const placement = { gpuId: candidate.gpuId, datacenterId: candidate.datacenterId };
      try {
        context.onProgress?.({ stage: "provisioning", message: `Trying ${candidate.gpuId} in ${candidate.datacenterId} ($${candidate.priceUsdPerHour}/h)` });
        const created = await this.createWorkerPod(job, context, { role: "gpu", volumeId, token, placement });
        return { ...created, placement };
      } catch (error) {
        if (!isCapacityError(error)) throw error;
        last = error;
      }
    }
    throw backendError(
      "CLOUD_CAPACITY_UNAVAILABLE",
      `All ${candidates.length} candidate GPU placement(s) within range rejected the request for capacity.`,
      "Retry later or raise --max-gpu-price. Capacity is never reserved by a quote.",
      { candidates: candidates.length },
      last,
    );
  }

  /** Starts a GPU worker. With `watchCacheFailure`, a cache-missing/invalid failure returns no handle so the caller can rebuild. */
  private async startGpu(
    job: ApprovedJob,
    context: BackendContext,
    volumeId: string | undefined,
    options: { watchCacheFailure?: boolean } = {},
  ): Promise<{ handle?: JobHandle }> {
    const token = randomBytes(32).toString("hex");
    await this.options.tokenStore.set(job.runId, token);
    context.onProgress?.({ stage: "provisioning" });
    const { pod, intentId, placement } = await this.createGpuPod(job, context, volumeId, token);
    const endpoint = this.endpoint(pod.id);
    const client = this.client(endpoint, token);
    this.clients.set(job.runId, client);

    context.onProgress?.({ stage: "booting" });
    await client.waitUntilReady({ timeoutMs: this.readyTimeoutMs, intervalMs: this.options.pollIntervalMs, signal: context.signal, abortIf: () => this.podFatal(pod.id) });
    context.onProgress?.({ stage: "uploading" });
    for (const file of job.inputs) await client.uploadInput(job.runId, file);
    await client.start(toWireJob(job, { mode: "execute", ...(volumeId ? { volumeMount: VOLUME_MOUNT } : {}) }));

    if (options.watchCacheFailure) {
      // The worker verifies the volume cache first; a bad cache fails before anything expensive.
      for (let i = 0; i < 120; i += 1) {
        const snapshot = await client.status(job.runId);
        if (snapshot.state === "failed" && (snapshot.error?.code === "CLOUD_CACHE_MISSING" || snapshot.error?.code === "CLOUD_CACHE_INVALID")) {
          await this.terminateAndConfirm(pod.id, intentId, context);
          this.clients.delete(job.runId);
          return {};
        }
        if (snapshot.state !== "running" || snapshot.stage !== "preparing_assets") break;
        await this.sleep(this.options.pollIntervalMs ?? 2000);
      }
    }
    return { handle: { version: EXECUTION_CONTRACT_VERSION, runId: job.runId, podId: pod.id, ...(volumeId ? { volumeId } : {}), gpuId: placement.gpuId, datacenterId: placement.datacenterId, endpoint } };
  }

  /** Terminate through the provider, then require the provider to show the Pod gone before marking it deleted. */
  private async terminateAndConfirm(podId: string, intentId: string, context: Pick<BackendContext, "ledger">): Promise<boolean> {
    context.ledger.beginDelete(intentId);
    try {
      await this.options.provider.terminatePod(podId);
    } catch {
      return false;
    }
    const deadline = (this.options.now ?? Date.now)() + (this.options.terminationWaitMs ?? 60_000);
    for (;;) {
      const pod = await this.options.provider.getPod(podId).catch(() => undefined);
      if (pod === null || pod?.status === "TERMINATED") {
        context.ledger.deleted(intentId);
        this.deletedIntents.add(intentId);
        return true;
      }
      if ((this.options.now ?? Date.now)() >= deadline) return false;
      await this.sleep(2000);
    }
  }

  reconnect(runId: string, podId: string, volumeId?: string): JobHandle {
    return { version: EXECUTION_CONTRACT_VERSION, runId, podId, ...(volumeId ? { volumeId } : {}), endpoint: this.endpoint(podId) };
  }

  async observe(handle: JobHandle, after = 0): Promise<JobSnapshot> {
    return (await this.clientFor(handle)).status(handle.runId, after);
  }

  async cancel(handle: JobHandle): Promise<void> {
    await (await this.clientFor(handle)).cancel(handle.runId);
  }

  async collect(handle: JobHandle, localOutputDir: string, options: { signal?: AbortSignal } = {}): Promise<ArtifactInventory> {
    return (await this.clientFor(handle)).collect(handle.runId, localOutputDir, options);
  }

  async release(handle: JobHandle | { runId: string }, context: Pick<BackendContext, "ledger">): Promise<void> {
    for (const entry of this.tracked.get(handle.runId) ?? []) {
      if (!entry.podId || this.deletedIntents.has(entry.intentId)) continue;
      await this.terminateAndConfirm(entry.podId, entry.intentId, context);
    }
    this.clients.delete(handle.runId);
    await this.options.tokenStore.delete(handle.runId).catch(() => undefined);
  }
}
