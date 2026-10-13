import fs from "node:fs";
import path from "node:path";
import { getAdapter, type ModelAdapterDefinition, type RunContext } from "@moldesk/adapters";
import { isCloudEligible, listAvailableModels, type CloudSpec, type ModelManifestV1 } from "@moldesk/registry";
import {
  getMoldeskPaths,
  type ApprovedJob,
  type ArtifactInventory,
  type CloudPod,
  type CloudProvider,
  type ExecutionBackend,
  type JobHandle,
  type JobSnapshot,
  type JobStage,
  type MoldeskPaths,
  type ResourceLedger,
} from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import { digest, sha256File } from "../hash.js";
import {
  allocateRunDirectory,
  collectRunOutputs,
  createRunSnapshot,
  finalizeRun,
  prepareRunParams,
  toErrorInfo,
  writeRunRecord,
} from "../run-lifecycle.js";
import type { RunCompute, RunModelResult, RunRecord } from "../run.js";
import type { DeadlineGuard } from "./guard.js";
import { assertApprovalValid, buildQuote, type CloudApproval, type CloudQuote } from "./quote.js";
import { CloudJournal, type CloudCachePolicy, type CloudJobStage, type CloudResourceRecord, type ProviderResourceView } from "./state.js";

const REMOTE_PLATFORM = "linux-x64" as const;
/** Structural stand-in for "the Linux runtime the worker will install"; never a fake local installation. */
const REMOTE_INSTALLED = { runtime: { kind: "python", python: { platform: REMOTE_PLATFORM } } } as const;

export interface CloudQuoteOptions {
  cachePolicy: CloudCachePolicy;
  gpuId?: string;
  datacenterId?: string;
  maxBudgetUsd: number;
  maxLifetimeSeconds: number;
}

export interface CloudRunOptions extends CloudQuoteOptions {
  /** The exact quote the user saw, and their approval of it. */
  quote: CloudQuote;
  approval: CloudApproval;
}

export interface CloudRunModelOptions {
  params?: Record<string, string>;
  outputDir?: string;
  signal?: AbortSignal;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
  onProgress?: (event: { stage: JobStage | "quote" | "cleanup"; message?: string }) => void;
  visualize?: boolean;
  cloud: CloudRunOptions;
}

export interface ResolvedModel {
  manifest: ModelManifestV1;
  adapter: ModelAdapterDefinition;
}

export interface CloudRunDeps {
  provider: CloudProvider;
  paths?: MoldeskPaths;
  /** Required by `runCloudModel`; `planCloudRun` does not provision. */
  backend?: ExecutionBackend;
  guard?: DeadlineGuard;
  /** Non-secret scope identifying the provider account (credential fingerprint or account id). */
  accountScope?: string;
  journal?: CloudJournal;
  resolveModel?: (name: string) => ResolvedModel;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** How long a failed result download may be retried while the machine is kept alive. */
  recoveryWindowSeconds?: number;
  cleanupAttempts?: number;
}

export interface CloudPlan {
  quote: CloudQuote;
  manifest: ModelManifestV1;
  cloud: CloudSpec;
  adapter: ModelAdapterDefinition;
  resolvedInputPath: string;
  input: { fileName: string; sha256: string; sizeBytes: number };
  suppliedParams: Record<string, string>;
  effectiveParams: Record<string, unknown>;
}

function failure(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

function defaultResolveModel(name: string): ResolvedModel {
  const manifest = listAvailableModels().find((entry) => entry.name === name);
  if (!manifest) throw failure("UNKNOWN_MODEL", `Unknown model "${name}".`, "Run `moldesk list` to see available models.");
  const adapter = getAdapter(name);
  if (!adapter) throw failure("ADAPTER_NOT_FOUND", `No adapter is registered for ${name}.`, "Repair the registry installation.");
  return { manifest, adapter };
}

/**
 * Validates everything that can be validated without provisioning and builds the quote. Rejects
 * (before any run directory or resource exists) for unknown/ineligible models, bad input or params,
 * an unaffordable or unavailable quote.
 */
export async function planCloudRun(
  modelName: string,
  inputPath: string,
  options: { params?: Record<string, string>; cloud: CloudQuoteOptions },
  deps: Pick<CloudRunDeps, "provider" | "resolveModel" | "journal" | "paths" | "accountScope">,
): Promise<CloudPlan> {
  const { manifest, adapter } = (deps.resolveModel ?? defaultResolveModel)(modelName);
  if (!isCloudEligible(manifest)) {
    throw failure(
      "CLOUD_MODEL_UNSUPPORTED",
      `${modelName} does not declare cloud execution support.`,
      "Run it locally, or use a model whose manifest has a validated `cloud` block.",
    );
  }
  const resolvedInputPath = path.resolve(inputPath);
  await adapter.validateInput(resolvedInputPath);
  const companions = (await adapter.resolveCompanionInputs?.(resolvedInputPath)) ?? [];
  if (companions.length > 0) {
    throw failure(
      "CLOUD_COMPANION_INPUTS_UNSUPPORTED",
      `${modelName} jobs that reference additional input files are not supported in the cloud yet.`,
      "Use a self-contained job file (for example sequences inline), or run locally.",
    );
  }
  const { suppliedParams, effectiveParams } = prepareRunParams(adapter, manifest.name, REMOTE_INSTALLED, options.params);

  const stat = fs.statSync(resolvedInputPath);
  const sha256 = await sha256File(resolvedInputPath);
  const catalog = await deps.provider.getCatalog();

  let existingVolumeDatacenterId: string | undefined;
  if (options.cloud.cachePolicy === "persistent" && deps.accountScope) {
    const owned = deps.journal ?? CloudJournal.open(deps.paths ?? getMoldeskPaths());
    try {
      existingVolumeDatacenterId = owned
        .listCaches()
        .find((cache) => cache.accountScope === deps.accountScope && cache.model === manifest.name && cache.state === "READY")?.datacenterId;
    } finally {
      if (!deps.journal) owned.close();
    }
  }

  const quote = buildQuote({
    provider: deps.provider.name,
    manifest,
    cloud: manifest.cloud,
    catalog,
    ...options.cloud,
    inputs: [{ role: "job", sha256, sizeBytes: stat.size }],
    existingVolumeDatacenterId,
  });
  return {
    quote,
    manifest,
    cloud: manifest.cloud,
    adapter,
    resolvedInputPath,
    input: { fileName: path.basename(resolvedInputPath), sha256, sizeBytes: stat.size },
    suppliedParams,
    effectiveParams,
  };
}

const STAGE_TO_JOB: Record<JobStage, CloudJobStage> = {
  provisioning: "provisioning",
  booting: "provisioning",
  uploading: "provisioning",
  preparing_assets: "preparing_assets",
  installing_runtime: "installing_runtime",
  verifying_runtime: "installing_runtime",
  running: "running",
  collecting: "transferring",
};

function ledgerFor(journal: CloudJournal, runId: string, deadlineAt: string): ResourceLedger {
  return {
    beginCreate(role) {
      const intent = journal.recordResourceIntent({ ...(role === "volume" ? {} : { runId }), role, deadlineAt: role === "volume" ? undefined : deadlineAt });
      return { intentId: intent.intentId, name: intent.name };
    },
    created: (intentId, providerId) => void journal.recordResourceCreated(intentId, providerId),
    beginDelete: (intentId) => void journal.markResourceDeletePending(intentId),
    deleted: (intentId) => void journal.markResourceDeleted(intentId),
  };
}

function toView(pod: CloudPod): ProviderResourceView {
  const match = /-(cpu|gpu)$/.exec(pod.name);
  return { providerId: pod.id, name: pod.name, role: (match?.[1] as "cpu" | "gpu" | undefined) ?? "gpu" };
}

export interface CleanupOutcome {
  confirmed: boolean;
  pending: Array<{ role: "cpu" | "gpu" | "volume"; providerId: string }>;
}

/**
 * Terminates and independently verifies every Pod this run owns. Uses the journal (never names
 * alone) for ownership, resolves ambiguous creates first, and never touches volumes. Bounded
 * retries; success means the provider shows the Pod gone, not that a call returned.
 */
export async function confirmRunResourcesGone(
  runId: string,
  deps: Pick<CloudRunDeps, "provider" | "sleep" | "cleanupAttempts">,
  journal: CloudJournal,
): Promise<CleanupOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = deps.cleanupAttempts ?? 3;
  const isPod = (record: CloudResourceRecord): boolean => record.role === "cpu" || record.role === "gpu";
  const open = (): CloudResourceRecord[] =>
    journal.listResources({ runId, states: ["create_pending", "active", "delete_pending"] }).filter(isPod);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const listed = await deps.provider.listPods();
      journal.reconcile(listed.filter((pod) => pod.status !== "TERMINATED").map(toView));
      const livePods = new Map(listed.filter((pod) => pod.status !== "TERMINATED").map((pod) => [pod.id, pod]));
      for (const record of open()) {
        if (!record.providerId) continue;
        if (!livePods.has(record.providerId)) {
          journal.markResourceDeleted(record.intentId);
          continue;
        }
        journal.markResourceDeletePending(record.intentId);
        await deps.provider.terminatePod(record.providerId);
        const after = await deps.provider.getPod(record.providerId);
        if (after === null || after.status === "TERMINATED") journal.markResourceDeleted(record.intentId);
      }
    } catch {
      // Provider unreachable this attempt; the journal keeps the debt and we retry.
    }
    if (open().length === 0) return { confirmed: true, pending: [] };
    if (attempt < attempts) await sleep(1000 * attempt);
  }
  return {
    confirmed: false,
    pending: open().map((record) => ({ role: record.role, providerId: record.providerId ?? record.intentId })),
  };
}

/**
 * Runs an approved cloud job end to end. Before allocation it rejects like a local run; from
 * allocation on it always resolves with a finalized `run.json`. Paid machines are terminated and
 * verified before the report is generated, and cleanup failure never discards a valid result.
 */
export async function runCloudModel(modelName: string, inputPath: string, options: CloudRunModelOptions, deps: CloudRunDeps): Promise<RunModelResult> {
  const { backend, guard } = deps;
  if (!backend || !guard) throw failure("CLOUD_BACKEND_MISSING", "Cloud execution is not configured.", "Provide an execution backend and deadline guard.");
  const paths = deps.paths ?? getMoldeskPaths();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = deps.pollIntervalMs ?? 5000;

  // --- Pre-allocation: validate, re-quote, verify consent. Failures reject; nothing exists yet. ---
  const plan = await planCloudRun(modelName, inputPath, { params: options.params, cloud: options.cloud }, { ...deps, paths });
  assertApprovalValid(options.cloud.quote, options.cloud.approval, plan.quote, now());
  const quote = plan.quote;

  const ownJournal = deps.journal === undefined;
  const journal = deps.journal ?? CloudJournal.open(paths);
  try {
    // --- Allocate and snapshot. A failure here finalizes run.json; nothing paid exists yet. ---
    const dirs = allocateRunDirectory(paths);
    const snapshot = await createRunSnapshot({
      dirs,
      manifest: plan.manifest,
      adapter: plan.adapter,
      runtime: "python",
      installationFingerprint: "remote-pending",
      resolvedInputPath: plan.resolvedInputPath,
      suppliedParams: options.params ?? {},
      effectiveParams: plan.effectiveParams,
      signal: options.signal,
    });
    if (!snapshot.ok) return { status: snapshot.record.status as RunModelResult["status"], record: snapshot.record };
    const { record, startedAt, storedInputPath } = snapshot;
    const { runDirPath } = dirs;

    const deadlineAt = new Date(now().getTime() + quote.maxLifetimeSeconds * 1000).toISOString();
    const compute: RunCompute = {
      provider: deps.provider.name,
      cachePolicy: quote.cachePolicy,
      quoteId: quote.id,
      stage: "approved",
      datacenterId: quote.datacenterId,
      gpuId: quote.gpu.id,
      resources: [],
      cleanup: "confirmed",
    };
    record.compute = compute;
    const persist = (): void => writeRunRecord(runDirPath, record);

    const localContext: RunContext = {
      manifestName: plan.manifest.name,
      inputPath: storedInputPath,
      outputDir: dirs.outputDir,
      modelDir: path.join(runDirPath, "remote-model"),
      assetsDir: path.join(runDirPath, "remote-assets"),
      params: plan.effectiveParams,
      runtimeExecutable: "",
      platform: REMOTE_PLATFORM,
    };
    const finish = (): Promise<RunModelResult> =>
      finalizeRun({ adapter: plan.adapter, context: localContext, runDirPath, record, startedAt, signal: options.signal, visualize: options.visualize, outputDir: options.outputDir });
    const abort = (code: string, message: string, status: RunRecord["status"] = "failed"): void => {
      record.status = status;
      record.error = { code, message };
    };

    // The primary input must be exactly what was quoted.
    if (record.input[0]?.sha256 !== plan.input.sha256) {
      abort("CLOUD_INPUT_CHANGED", "The input file changed after the quote was produced.");
      return finish();
    }

    const accountScope = deps.accountScope ?? "unscoped";
    journal.createJob({
      runId: dirs.runId,
      accountScope,
      quoteDigest: quote.id,
      cachePolicy: quote.cachePolicy,
      gpuId: quote.gpu.id,
      datacenterId: quote.datacenterId,
      deadlineAt,
      manifestDigest: digest(plan.manifest),
    });

    // --- Deadline guard BEFORE any paid compute. Refusal here means nothing was provisioned. ---
    let guardId: string | undefined;
    try {
      guardId = (await guard.register({ runId: dirs.runId, provider: deps.provider.name, clientId: journal.clientId, deadlineAt })).id;
    } catch (error) {
      const info = toErrorInfo(error, "CLOUD_GUARD_UNAVAILABLE");
      abort(info.code, info.message);
      journal.updateJob(dirs.runId, { stage: "done", status: "failed", error: info });
      return finish();
    }

    const job: ApprovedJob = {
      version: 1,
      runId: dirs.runId,
      model: plan.manifest.name,
      modelVersion: plan.manifest.modelVersion,
      manifestDigest: digest(plan.manifest),
      cachePolicy: quote.cachePolicy,
      gpuId: quote.gpu.id,
      datacenterId: quote.datacenterId,
      images: plan.cloud.images,
      containerDiskGb: plan.cloud.ephemeralDiskGb,
      volumeGb: plan.cloud.volumeGb,
      assetLayoutRevision: plan.cloud.assetLayoutRevision,
      cpuAssetPreparation: plan.cloud.cpuAssetPreparation,
      params: plan.effectiveParams,
      inputs: [{ role: "job", relativePath: plan.input.fileName, sha256: plan.input.sha256, sizeBytes: plan.input.sizeBytes, sourcePath: storedInputPath }],
      deadlineAt,
    };
    const ledger = ledgerFor(journal, dirs.runId, deadlineAt);
    const progress = (stage: JobStage, message?: string): void => {
      compute.stage = stage;
      journal.updateJob(dirs.runId, { stage: STAGE_TO_JOB[stage] });
      persist();
      options.onProgress?.({ stage, message });
    };

    let handle: JobHandle | undefined;
    let inventory: ArtifactInventory | undefined;
    let snapshotLast: JobSnapshot | undefined;
    let cursor = 0;
    try {
      handle = await backend.start(job, { ledger, signal: options.signal, onProgress: (event) => progress(event.stage, event.message) });
      record.status = "running";
      persist();

      // --- Observe until the worker reports a terminal state. Bounded by the approved deadline. ---
      let consecutiveObserveFailures = 0;
      for (;;) {
        if (options.signal?.aborted) {
          await backend.cancel(handle).catch(() => undefined);
          abort("RUN_CANCELLED", "Run was cancelled.", "cancelled");
          break;
        }
        if (now().getTime() > Date.parse(deadlineAt)) {
          await backend.cancel(handle).catch(() => undefined);
          abort("CLOUD_DEADLINE_EXCEEDED", `The ${quote.maxLifetimeSeconds}s lifetime limit was reached before the run finished.`);
          break;
        }
        try {
          snapshotLast = await backend.observe(handle, cursor);
          consecutiveObserveFailures = 0;
        } catch (error) {
          consecutiveObserveFailures += 1;
          if (consecutiveObserveFailures >= 3) {
            const info = toErrorInfo(error, "CLOUD_WORKER_UNREACHABLE");
            abort("CLOUD_WORKER_UNREACHABLE", `The worker stopped responding: ${info.message}`);
            break;
          }
          await sleep(pollMs);
          continue;
        }
        cursor = snapshotLast.logs.cursor;
        if (snapshotLast.logs.stdout) options.onLog?.("stdout", snapshotLast.logs.stdout);
        if (snapshotLast.logs.stderr) options.onLog?.("stderr", snapshotLast.logs.stderr);
        if (snapshotLast.stage !== compute.stage) progress(snapshotLast.stage);
        if (snapshotLast.state === "succeeded" || snapshotLast.state === "failed" || snapshotLast.state === "cancelled") break;
        await sleep(pollMs);
      }

      if (snapshotLast?.runtime) {
        const runtime = snapshotLast.runtime;
        compute.hardware = runtime.gpu;
        compute.remoteCommand = runtime.command;
        compute.pythonVersion = runtime.pythonVersion;
        compute.dependencyFreeze = runtime.dependencyFreeze;
        compute.sourceRevision = runtime.sourceRevision;
        record.installationFingerprint = runtime.installationFingerprint ?? digest(runtime);
      }
      record.process = { exitCode: snapshotLast?.exitCode };

      if (record.status === "running") {
        if (snapshotLast?.state === "cancelled") abort("RUN_CANCELLED", "Run was cancelled.", "cancelled");
        else if (snapshotLast?.state === "failed") {
          const exit = snapshotLast.exitCode;
          abort(
            snapshotLast.error?.code ?? "RUN_EXECUTION_FAILED",
            snapshotLast.error?.message ?? `${modelName} exited with code ${exit ?? "unknown"}.`,
          );
        } else {
          // --- Succeeded on the worker: download and verify. Retried only inside a bounded window. ---
          progress("collecting");
          journal.updateJob(dirs.runId, { transferState: "downloading" });
          const windowEnd = Math.min(Date.parse(deadlineAt), now().getTime() + (deps.recoveryWindowSeconds ?? 600) * 1000);
          let lastError: unknown;
          for (let attempt = 1; !inventory; attempt += 1) {
            try {
              inventory = await backend.collect(handle, dirs.outputDir);
            } catch (error) {
              lastError = error;
              if (options.signal?.aborted || now().getTime() + 2000 * attempt > windowEnd) break;
              await sleep(2000 * attempt);
            }
          }
          if (!inventory) {
            const info = toErrorInfo(lastError, "CLOUD_TRANSFER_FAILED");
            journal.updateJob(dirs.runId, { transferState: "failed" });
            abort("CLOUD_TRANSFER_FAILED", `Results could not be downloaded: ${info.message}`);
          } else {
            journal.updateJob(dirs.runId, { transferState: "verified" });
            // Existing local collection: a missing required output is a failure even after exit 0.
            record.outputs = await collectRunOutputs(plan.adapter, localContext);
            record.status = "succeeded";
          }
        }
      }
    } catch (error) {
      const info = toErrorInfo(error, "CLOUD_RUN_FAILED");
      if (options.signal?.aborted) abort("RUN_CANCELLED", "Run was cancelled.", "cancelled");
      else abort(info.code, info.message);
    }

    // --- Cleanup first (separate from the possibly-aborted signal), then report generation. ---
    options.onProgress?.({ stage: "cleanup" });
    journal.updateJob(dirs.runId, { stage: "cleaning_up" });
    if (handle) await backend.release(handle, { ledger }).catch(() => undefined);
    else await backend.release({ runId: dirs.runId }, { ledger }).catch(() => undefined);
    const cleanup = await confirmRunResourcesGone(dirs.runId, deps, journal);
    compute.resources = journal
      .listResources({ runId: dirs.runId })
      .filter((resource) => resource.providerId)
      .map((resource) => ({ role: resource.role, providerId: resource.providerId! }));
    compute.cleanup = cleanup.confirmed ? "confirmed" : "pending";
    if (cleanup.confirmed && guardId) await guard.disarm(guardId).catch(() => undefined);

    journal.updateJob(dirs.runId, {
      stage: "done",
      status: cleanup.confirmed ? (record.status === "succeeded" ? "succeeded" : record.status === "cancelled" ? "cancelled" : "failed") : "cleanup_pending",
      error: cleanup.confirmed ? record.error ?? null : { code: "CLOUD_CLEANUP_PENDING", message: "Paid resources could not be confirmed deleted." },
    });
    const result = await finish();
    if (!cleanup.confirmed) result.cleanupPending = { code: "CLOUD_CLEANUP_PENDING", resources: cleanup.pending };
    return result;
  } finally {
    if (ownJournal) journal.close();
  }
}
