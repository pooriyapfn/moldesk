import fs from "node:fs";
import path from "node:path";
import { getMoldeskPaths, runDir, type ExecutionBackend, type MoldeskPaths } from "@moldesk/runtime";
import type { RunContext } from "@moldesk/adapters";
import { MoldeskError } from "../errors.js";
import { collectRunOutputs, finalizeRun, writeRunRecord } from "../run-lifecycle.js";
import type { RunModelResult, RunRecord } from "../run.js";
import type { DeadlineGuard } from "./guard.js";
import { confirmRunResourcesGone, defaultResolveModelForRecovery, type CleanupOutcome, type CloudRunDeps } from "./run.js";
import { CloudJournal, type CloudCacheRecord, type CloudResourceRecord } from "./state.js";

function failure(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

export type RecoverDeps = Pick<CloudRunDeps, "provider" | "paths" | "resolveModel" | "sleep" | "cleanupAttempts"> & {
  backend?: ExecutionBackend;
  guard?: DeadlineGuard;
};

export interface RecoverOptions {
  /** Terminate even if the worker still reports the job as running (stops further rental; loses unfinished results). */
  terminateRunning?: boolean;
}

export interface RecoverResult {
  runId: string;
  /** Results were downloaded and verified during recovery. */
  collected: boolean;
  cleanup: CleanupOutcome;
  /** Present when a previously failed run became a verified success. */
  result?: RunModelResult;
  status: RunRecord["status"];
}

function readRunRecord(paths: MoldeskPaths, runId: string): { record: RunRecord; runDirPath: string } {
  const runDirPath = runDir(runId, { MOLDESK_HOME: paths.home });
  const file = path.join(runDirPath, "run.json");
  if (!fs.existsSync(file)) throw failure("CLOUD_RUN_UNKNOWN", `No run record for ${runId}.`, "Check the run id with `moldesk cloud status`.");
  return { record: JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord, runDirPath };
}

/**
 * Resumes cleanup (and, when possible, result transfer) for a cloud run after a crash, cancellation
 * or transfer failure. It never starts inference again: the only paid actions it can take are
 * downloading from a Pod that already exists and terminating Pods this installation owns.
 */
export async function recoverCloudRun(runId: string, deps: RecoverDeps, options: RecoverOptions = {}): Promise<RecoverResult> {
  const paths = deps.paths ?? getMoldeskPaths();
  const journal = CloudJournal.open(paths);
  try {
    const job = journal.getJob(runId);
    if (!job) throw failure("CLOUD_RUN_UNKNOWN", `No cloud job is recorded for ${runId}.`, "Only runs started with --compute runpod can be recovered.");
    const { record, runDirPath } = readRunRecord(paths, runId);
    let collected = false;
    let result: RunModelResult | undefined;

    // --- Try to fetch results that were left on a still-running Pod. ---
    const livePod = journal.listResources({ runId, states: ["active", "delete_pending"] }).find((resource) => resource.role === "gpu" && resource.providerId);
    let stillRunning = false;
    if (record.status !== "succeeded" && livePod?.providerId && deps.backend?.reconnect) {
      const handle = deps.backend.reconnect(runId, livePod.providerId, job.volumeId ?? undefined);
      try {
        const snapshot = await deps.backend.observe(handle);
        if (snapshot.state === "succeeded") {
          const outputDir = path.join(runDirPath, "output");
          await deps.backend.collect(handle, outputDir);
          const resolved = (deps.resolveModel ?? defaultResolveModelForRecovery)(record.model);
          const input = record.input[0]!;
          const context: RunContext = {
            manifestName: record.model,
            inputPath: input.storedPath,
            outputDir,
            modelDir: path.join(runDirPath, "remote-model"),
            assetsDir: path.join(runDirPath, "remote-assets"),
            params: record.parameters.effective,
            runtimeExecutable: "",
            platform: "linux-x64",
          };
          record.outputs = await collectRunOutputs(resolved.adapter, context);
          record.status = "succeeded";
          delete record.error;
          journal.updateJob(runId, { transferState: "verified" });
          collected = true;
          result = { status: "succeeded", record };
        } else if (snapshot.state === "running") {
          stillRunning = true;
        }
      } catch {
        // Still unreachable or incomplete: fall through to cleanup; the failure record stays as is.
      }
    }

    // A job that is genuinely still running keeps its (already approved) rental unless told otherwise.
    if (stillRunning && !options.terminateRunning) {
      return { runId, collected: false, cleanup: { confirmed: false, pending: [{ role: "gpu", providerId: livePod!.providerId! }] }, status: record.status };
    }

    // A run interrupted before it finished must not stay "running" forever.
    if (record.status === "preparing" || record.status === "running") {
      const finishedAt = new Date().toISOString();
      record.status = "failed";
      record.error = { code: "CLOUD_RUN_INTERRUPTED", message: "The run was interrupted before it finished; recovery cleaned up its cloud resources." };
      record.finishedAt = finishedAt;
      record.durationMs = Date.parse(finishedAt) - Date.parse(record.startedAt);
    }

    // --- Cleanup: terminate and verify only what the journal says this installation owns. ---
    const cleanup = await confirmRunResourcesGone(runId, deps, journal);
    if (record.compute) record.compute.cleanup = cleanup.confirmed ? "confirmed" : "pending";
    if (cleanup.confirmed && job.guardId && deps.guard) await deps.guard.disarm(job.guardId).catch(() => undefined);
    journal.updateJob(runId, {
      stage: "done",
      status: cleanup.confirmed ? (record.status === "succeeded" ? "succeeded" : record.status === "cancelled" ? "cancelled" : "failed") : "cleanup_pending",
      error: cleanup.confirmed ? record.error ?? null : { code: "CLOUD_CLEANUP_PENDING", message: "Paid resources could not be confirmed deleted." },
    });

    if (collected && result) {
      const resolved = (deps.resolveModel ?? defaultResolveModelForRecovery)(record.model);
      const input = record.input[0]!;
      result = await finalizeRun({
        adapter: resolved.adapter,
        context: {
          manifestName: record.model,
          inputPath: input.storedPath,
          outputDir: path.join(runDirPath, "output"),
          modelDir: path.join(runDirPath, "remote-model"),
          assetsDir: path.join(runDirPath, "remote-assets"),
          params: record.parameters.effective,
          runtimeExecutable: "",
          platform: "linux-x64",
        },
        runDirPath,
        record,
        startedAt: record.startedAt,
      });
    } else {
      writeRunRecord(runDirPath, record);
    }
    return { runId, collected, cleanup, ...(result ? { result } : {}), status: record.status };
  } finally {
    journal.close();
  }
}

// --- caches ---------------------------------------------------------------------------------

export interface CloudCacheListing {
  cache: CloudCacheRecord;
  /** Whether the provider still has the volume (a deleted volume means the cache is gone). */
  volumeExists: boolean | undefined;
  volumeSizeGb?: number;
}

export async function listCloudCaches(deps: Pick<CloudRunDeps, "provider" | "paths" | "accountScope">): Promise<CloudCacheListing[]> {
  const journal = CloudJournal.open(deps.paths ?? getMoldeskPaths());
  try {
    const volumes = await deps.provider.listVolumes().catch(() => undefined);
    const byId = new Map((volumes ?? []).map((volume) => [volume.id, volume]));
    return journal
      .listCaches()
      .filter((cache) => !deps.accountScope || cache.accountScope === deps.accountScope)
      .map((cache) => ({
        cache,
        volumeExists: volumes ? byId.has(cache.volumeId) : undefined,
        ...(byId.get(cache.volumeId) ? { volumeSizeGb: byId.get(cache.volumeId)!.sizeGb } : {}),
      }));
  } finally {
    journal.close();
  }
}

export interface CacheDeletionPlan {
  model: string;
  /** Exactly what will be removed. Nothing else is touched. */
  volumes: Array<{ volumeId: string; datacenterId: string; sizeGb?: number; cacheKeys: string[] }>;
  /** Reasons deletion cannot proceed right now. */
  blockers: string[];
}

export async function planCloudCacheDeletion(model: string, deps: Pick<CloudRunDeps, "provider" | "paths" | "accountScope">): Promise<CacheDeletionPlan> {
  const journal = CloudJournal.open(deps.paths ?? getMoldeskPaths());
  try {
    const caches = journal.listCaches().filter((cache) => cache.model === model && (!deps.accountScope || cache.accountScope === deps.accountScope));
    const volumes = new Map<string, CacheDeletionPlan["volumes"][number]>();
    const volumeList = await deps.provider.listVolumes();
    for (const cache of caches) {
      const entry = volumes.get(cache.volumeId) ?? { volumeId: cache.volumeId, datacenterId: cache.datacenterId, sizeGb: volumeList.find((volume) => volume.id === cache.volumeId)?.sizeGb, cacheKeys: [] };
      entry.cacheKeys.push(cache.cacheKey);
      volumes.set(cache.volumeId, entry);
    }
    const blockers: string[] = [];
    for (const job of journal.listOpenJobs()) {
      if (job.volumeId && volumes.has(job.volumeId)) blockers.push(`Run ${job.runId} is still using volume ${job.volumeId} (${job.stage}, ${job.status}).`);
    }
    // A volume other caches also live on (another model) must not be deleted from under them.
    for (const volumeId of volumes.keys()) {
      const sharedBy = journal.listCaches().filter((cache) => cache.volumeId === volumeId && cache.model !== model);
      if (sharedBy.length > 0) blockers.push(`Volume ${volumeId} also holds caches for: ${[...new Set(sharedBy.map((cache) => cache.model))].join(", ")}.`);
    }
    return { model, volumes: [...volumes.values()], blockers };
  } finally {
    journal.close();
  }
}

export interface CacheDeletionResult {
  deleted: Array<{ volumeId: string }>;
  failed: Array<{ volumeId: string; reason: string }>;
}

/** Deletes exactly the volumes in a plan the caller already showed and had confirmed. Journal ownership is required. */
export async function executeCloudCacheDeletion(plan: CacheDeletionPlan, deps: Pick<CloudRunDeps, "provider" | "paths" | "accountScope">): Promise<CacheDeletionResult> {
  if (plan.blockers.length > 0) throw failure("CLOUD_CACHE_IN_USE", plan.blockers.join(" "), "Wait for active runs to finish, or delete the other caches first.", { blockers: plan.blockers });
  const journal = CloudJournal.open(deps.paths ?? getMoldeskPaths());
  const result: CacheDeletionResult = { deleted: [], failed: [] };
  try {
    for (const volume of plan.volumes) {
      const owner: CloudResourceRecord | undefined = journal.findOwnedByProviderId(volume.volumeId);
      if (!owner || owner.role !== "volume") {
        result.failed.push({ volumeId: volume.volumeId, reason: "This installation did not create that volume, so it will not delete it." });
        continue;
      }
      try {
        journal.markResourceDeletePending(owner.intentId);
        await deps.provider.deleteVolume(volume.volumeId);
        if ((await deps.provider.getVolume(volume.volumeId)) !== null) {
          result.failed.push({ volumeId: volume.volumeId, reason: "The provider still lists the volume after deletion." });
          continue;
        }
        journal.markResourceDeleted(owner.intentId);
        for (const key of volume.cacheKeys) {
          journal.deleteCache({ accountScope: deps.accountScope ?? journal.listCaches().find((cache) => cache.volumeId === volume.volumeId)?.accountScope ?? "", datacenterId: volume.datacenterId, volumeId: volume.volumeId, cacheKey: key });
        }
        result.deleted.push({ volumeId: volume.volumeId });
      } catch (error) {
        result.failed.push({ volumeId: volume.volumeId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  } finally {
    journal.close();
  }
}
