import type { CloudResourceRoleName } from "./types.js";

/**
 * Wire and journal contract between the core orchestrator and a remote execution backend. All
 * types are plain JSON and versioned, so a restarted client can reconstruct a job from the journal
 * and a worker of a different release can reject what it does not understand.
 */
export const EXECUTION_CONTRACT_VERSION = 1;

export type CachePolicy = "ephemeral" | "persistent";

export interface JobInputFile {
  /** `"job"` for the primary input, or the adapter-declared companion id. */
  role: string;
  /** Path relative to the job's `input/` directory; never absolute and never containing `..`. */
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  /** Client-local source. Never sent to the worker or written to the journal. */
  sourcePath: string;
}

export interface ApprovedJob {
  version: typeof EXECUTION_CONTRACT_VERSION;
  runId: string;
  model: string;
  modelVersion: string;
  manifestDigest: string;
  cachePolicy: CachePolicy;
  gpuId: string;
  datacenterId: string;
  /** Digest-pinned worker images from the manifest's `cloud` block. */
  images: { gpu: string; cpu: string };
  containerDiskGb: number;
  volumeGb: number;
  assetLayoutRevision: string;
  cpuAssetPreparation: boolean;
  /** Validated, defaulted adapter params. */
  params: Record<string, unknown>;
  inputs: JobInputFile[];
  /** After this instant every resource of the job must be gone. */
  deadlineAt: string;
  /** Digest of model, source revision, asset list and layout revision; names the on-volume cache. */
  cacheKey: string;
  /** Existing persistent volume to reuse, when one is known and compatible. */
  reuseVolumeId?: string;
}

/** What a backend returns once the worker is executing; JSON-serializable. */
export interface JobHandle {
  version: typeof EXECUTION_CONTRACT_VERSION;
  runId: string;
  podId: string;
  volumeId?: string;
  /** Verified HTTPS worker endpoint. The per-job token is held in the credential store, not here. */
  endpoint: string;
}

export type JobStage =
  | "provisioning"
  | "booting"
  | "uploading"
  | "preparing_assets"
  | "installing_runtime"
  | "verifying_runtime"
  | "running"
  | "collecting";

export type JobState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface RemoteRuntimeReport {
  pythonVersion?: string;
  /** `uv pip freeze` output lines. */
  dependencyFreeze: string[];
  sourceRevision?: string;
  gpu?: { name: string; memoryMb?: number; driverVersion?: string; cudaVersion?: string };
  /** The command the worker ran; `cwd` is a POSIX path on the worker. */
  command?: { executable: string; args: string[]; cwd: string };
  installationFingerprint?: string;
  /** Persistent-cache details reported by `prepare-assets` jobs. */
  cache?: { checksumManifestSha256: string; sizeBytes: number; fileCount: number; reused: boolean };
}

export interface JobSnapshot {
  stage: JobStage;
  state: JobState;
  exitCode?: number;
  error?: { code: string; message: string };
  /** Resumable log window: pass `cursor` back as `after` to continue. */
  logs: { cursor: number; stdout: string; stderr: string };
  runtime?: RemoteRuntimeReport;
}

export interface InventoryFile {
  /** POSIX path relative to the job's `output/` directory. */
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ArtifactInventory {
  version: typeof EXECUTION_CONTRACT_VERSION;
  files: InventoryFile[];
}

/**
 * Journals paid-resource intent for a backend. The backend must call `beginCreate` before asking a
 * provider to create anything, `created` immediately after the response, `beginDelete` before a
 * delete and `deleted` only once the provider confirmed deletion or absence.
 */
export interface ResourceLedger {
  beginCreate(role: CloudResourceRoleName): { intentId: string; name: string };
  created(intentId: string, providerId: string): void;
  beginDelete(intentId: string): void;
  deleted(intentId: string): void;
}

/** Journals persistent-cache state for a backend. Only used for the `persistent` policy. */
export interface CacheLedger {
  /** A cache the journal believes is READY for this job's key, if any. */
  lookup(): { volumeId: string; datacenterId: string } | undefined;
  /** Record the volume and a PREPARING cache row. */
  begin(volume: { volumeId: string; datacenterId: string }): void;
  verifying(): void;
  ready(details: { sizeBytes: number; checksumManifestDigest: string }): void;
  failed(): void;
  /** Same-client lease around preparation; false when another process holds it. */
  acquireLease(ttlSeconds: number): boolean;
  releaseLease(): void;
}

export interface BackendContext {
  ledger: ResourceLedger;
  cache?: CacheLedger;
  signal?: AbortSignal;
  onProgress?: (event: { stage: JobStage; message?: string }) => void;
}

export interface ExecutionBackend {
  /** Provision, bootstrap the worker, upload inputs, prepare assets and runtime, and begin execution. */
  start(job: ApprovedJob, context: BackendContext): Promise<JobHandle>;
  /** Rebuild a handle for a Pod this client created earlier (e.g. after a restart) so results can still be fetched. */
  reconnect?(runId: string, podId: string, volumeId?: string): JobHandle;
  observe(handle: JobHandle, after?: number): Promise<JobSnapshot>;
  cancel(handle: JobHandle): Promise<void>;
  /** Download and verify every inventory file into `localOutputDir`; never reruns inference. */
  collect(handle: JobHandle, localOutputDir: string): Promise<ArtifactInventory>;
  /**
   * Terminate every paid resource this job owns (GPU/CPU pods; never the persistent volume) and
   * confirm via the provider. Safe to call repeatedly; absence is success.
   */
  release(handle: JobHandle | { runId: string }, context: Pick<BackendContext, "ledger">): Promise<void>;
}

export type WorkerMode = "execute" | "prepare-assets";

/** Job description sent to the worker: the approved job without client-local paths. */
export type WireJob = Omit<ApprovedJob, "inputs" | "reuseVolumeId"> & {
  inputs: Array<Omit<JobInputFile, "sourcePath">>;
  /** `prepare-assets` runs only asset preparation (CPU Pod); `execute` runs the model. */
  mode: WorkerMode;
  /** Where the persistent network volume is mounted in this Pod; absent for ephemeral runs. */
  volumeMount?: string;
  /** Lets a worker reclaim an expired on-volume cache lock; set only after the client confirmed the old owner is gone. */
  reclaimStaleLock?: boolean;
};

export function toWireJob(job: ApprovedJob, extra: { mode?: WorkerMode; volumeMount?: string; reclaimStaleLock?: boolean } = {}): WireJob {
  const { inputs, reuseVolumeId: _reuse, ...rest } = job;
  return {
    ...rest,
    inputs: inputs.map(({ sourcePath: _sourcePath, ...file }) => file),
    mode: extra.mode ?? "execute",
    ...(extra.volumeMount ? { volumeMount: extra.volumeMount } : {}),
    ...(extra.reclaimStaleLock ? { reclaimStaleLock: true } : {}),
  };
}

/** Port the worker listens on inside the Pod; the provider proxy exposes it over HTTPS. */
export const WORKER_PORT = 8000;
