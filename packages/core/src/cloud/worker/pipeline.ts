import fs from "node:fs";
import path from "node:path";
import { getAdapter, type ModelAdapterDefinition, type RunContext } from "@moldesk/adapters";
import { effectiveRuntimeSource, listAvailableModels, selectPythonRuntime, type ModelManifestV1 } from "@moldesk/registry";
import {
  PythonRuntimeProvider,
  cacheAsset,
  getMoldeskPaths,
  getSystemReport,
  materializeAsset,
  preparePythonEnvironment,
  type RemoteRuntimeReport,
  type RuntimeProvider,
} from "@moldesk/runtime";
import { MoldeskError } from "../../errors.js";
import { digest } from "../../hash.js";
import { acquireVolumeLock, cacheRoot, publishCache, verifyCache } from "./cache.js";
import type { PipelineContext, PipelineResult, WorkerPipeline } from "./server.js";

const REMOTE_PLATFORM = "linux-x64" as const;

export interface PipelineSteps {
  cacheAsset: typeof cacheAsset;
  materializeAsset: typeof materializeAsset;
  preparePythonEnvironment: typeof preparePythonEnvironment;
  getSystemReport: typeof getSystemReport;
  runtime: RuntimeProvider;
}

export interface ManifestPipelineOptions {
  /** Looks up the bundled manifest and adapter; the worker only ever runs what it ships with. */
  resolveModel?: (name: string) => { manifest: ModelManifestV1; adapter: ModelAdapterDefinition } | undefined;
  steps?: Partial<PipelineSteps>;
}

function defaultResolve(name: string) {
  const manifest = listAvailableModels().find((entry) => entry.name === name);
  const adapter = getAdapter(name);
  return manifest && adapter ? { manifest, adapter } : undefined;
}

function fail(code: string, message: string, remediation: string): MoldeskError {
  return new MoldeskError({ code, message, remediation });
}

/**
 * The real worker pipeline: prepare assets, install the Linux runtime, verify (CUDA included), build
 * the adapter's own command with POSIX paths, and execute. It reuses the same installer, adapter and
 * execution code as local runs and never accepts a command or manifest from the client; the client's
 * job only selects a bundled model and must match that manifest's digest exactly.
 */
export function createManifestPipeline(options: ManifestPipelineOptions = {}): WorkerPipeline {
  const steps: PipelineSteps = {
    cacheAsset,
    materializeAsset,
    preparePythonEnvironment,
    getSystemReport,
    runtime: new PythonRuntimeProvider(),
    ...options.steps,
  };
  const resolve = options.resolveModel ?? defaultResolve;

  return async (context: PipelineContext): Promise<PipelineResult> => {
    const { job, jobDir, inputDir, outputDir, signal } = context;
    const resolved = resolve(job.model);
    if (!resolved) throw fail("WORKER_MODEL_UNKNOWN", `This worker does not bundle ${job.model}.`, "Use a worker release that matches the client.");
    const { manifest, adapter } = resolved;
    if (digest(manifest) !== job.manifestDigest || manifest.modelVersion !== job.modelVersion) {
      throw fail("WORKER_MANIFEST_MISMATCH", "The worker's bundled manifest differs from the one the job was approved against.", "Use a worker release that matches the client version.");
    }
    if (manifest.cloud === undefined) throw fail("WORKER_MODEL_NOT_CLOUD", `${job.model} is not cloud-eligible.`, "Use a model with a cloud block.");

    const persistentRoot = job.volumeMount ? cacheRoot(job.volumeMount) : undefined;
    // Raw download objects live on the volume for persistent runs so a rebuild never re-downloads.
    const paths = getMoldeskPaths({ MOLDESK_HOME: persistentRoot ? path.join(persistentRoot, "home") : path.join(jobDir, "home") });
    const prepareAssetsInto = async (assetsTarget: string): Promise<void> => {
      fs.mkdirSync(assetsTarget, { recursive: true });
      for (const asset of manifest.assets ?? []) {
        if (signal.aborted) throw fail("RUN_CANCELLED", "Cancelled.", "None.");
        const object = await steps.cacheAsset(asset, paths, {
          onProgress: (progress) => context.log("stderr", `[assets] ${progress.message ?? progress.step}\n`),
        });
        await steps.materializeAsset(asset, object, assetsTarget);
      }
    };

    // --- CPU stage of a persistent run: assets only. No Python, no CUDA, no verification probe. ---
    if (job.mode === "prepare-assets") {
      if (!persistentRoot) throw fail("WORKER_BAD_JOB", "prepare-assets needs a persistent volume.", "Retry with a persistent cache policy.");
      context.setStage("preparing_assets");
      const params = { root: persistentRoot, key: job.cacheKey, manifestDigest: job.manifestDigest, layoutRevision: job.assetLayoutRevision };
      const existing = await verifyCache(params);
      if (existing.ok) {
        return { exitCode: 0, runtime: { dependencyFreeze: [], cache: { checksumManifestSha256: existing.metadata.checksumManifestSha256, sizeBytes: existing.metadata.sizeBytes, fileCount: existing.metadata.files.length, reused: true } } };
      }
      const lock = acquireVolumeLock({ root: persistentRoot, key: job.cacheKey, owner: job.runId, ttlSeconds: 3600, reclaimStale: job.reclaimStaleLock });
      try {
        const staging = path.join(persistentRoot, `${job.cacheKey}.staging-${job.runId}`);
        fs.rmSync(staging, { recursive: true, force: true });
        await prepareAssetsInto(path.join(staging, "assets"));
        const metadata = await publishCache({ ...params, stagingDir: staging });
        return { exitCode: 0, runtime: { dependencyFreeze: [], cache: { checksumManifestSha256: metadata.checksumManifestSha256, sizeBytes: metadata.sizeBytes, fileCount: metadata.files.length, reused: false } } };
      } finally {
        lock.release();
      }
    }

    // --- Assets for an execute job: ephemeral prepares them here; persistent verifies the volume's cache. ---
    let assetsDir = path.join(jobDir, "assets");
    const modelDir = path.join(jobDir, "runtime");
    context.setStage("preparing_assets");
    if (persistentRoot) {
      const verified = await verifyCache({ root: persistentRoot, key: job.cacheKey, manifestDigest: job.manifestDigest, layoutRevision: job.assetLayoutRevision });
      if (!verified.ok) throw Object.assign(fail(verified.code, verified.message, "The cache will be rebuilt on a CPU machine."), {});
      assetsDir = verified.assetsDir;
    } else {
      await prepareAssetsInto(assetsDir);
    }

    // --- Linux runtime in an ephemeral environment. ---
    context.setStage("installing_runtime");
    const runtime = selectPythonRuntime(manifest.runtimes, REMOTE_PLATFORM);
    const source = effectiveRuntimeSource(manifest, runtime);
    if (!source) throw fail("SOURCE_PROVENANCE_MISSING", `${job.model} has no pinned source.`, "Fix the manifest.");
    const prepared = await steps.preparePythonEnvironment({
      targetDir: modelDir,
      repository: source.repository,
      revision: source.revision,
      runtime,
      paths,
      onProgress: (progress) => context.log("stderr", `[install] ${progress.message ?? progress.step}\n`),
    });

    // --- GPU/CUDA verification happens here, after install and before any inference. ---
    context.setStage("verifying_runtime");
    const verification = await adapter.verifyInstallation({ manifestName: manifest.name, modelDir, assetsDir, platform: REMOTE_PLATFORM });
    if (!verification.passed) {
      throw fail("INSTALL_VERIFICATION_FAILED", `Verification failed for ${manifest.name}: ${verification.output ?? "unknown reason"}.`, "The worker image or GPU is not compatible with this model.");
    }

    // --- Build the command with the adapter, from worker-local POSIX paths. ---
    const primary = job.inputs.find((input) => input.role === "job");
    if (!primary) throw fail("WORKER_BAD_JOB", "The job has no primary input.", "Retry with a valid job.");
    const runContext: RunContext = {
      manifestName: manifest.name,
      inputPath: path.join(inputDir, ...primary.relativePath.split("/")),
      outputDir,
      modelDir,
      assetsDir,
      params: job.params,
      runtimeExecutable: prepared.executable,
      platform: REMOTE_PLATFORM,
    };
    const command = await adapter.command(runContext);

    context.setStage("running");
    const execution = await steps.runtime.execute({
      executable: command.executable,
      args: command.args,
      cwd: jobDir,
      env: command.env,
      signal,
      onStdout: (chunk) => context.log("stdout", chunk),
      onStderr: (chunk) => context.log("stderr", chunk),
    });

    const system = await steps.getSystemReport().catch(() => undefined);
    const gpu = system?.nvidia.gpus[0];
    const report: RemoteRuntimeReport = {
      pythonVersion: prepared.pythonVersion,
      dependencyFreeze: prepared.lock,
      sourceRevision: source.revision,
      ...(gpu
        ? {
            gpu: {
              name: gpu.name,
              ...(gpu.totalVramBytes !== undefined ? { memoryMb: Math.round(gpu.totalVramBytes / 1024 ** 2) } : {}),
              ...(system?.nvidia.driverVersion ? { driverVersion: system.nvidia.driverVersion } : {}),
              ...(system?.nvidia.driverCudaVersion ? { cudaVersion: system.nvidia.driverCudaVersion } : {}),
            },
          }
        : {}),
      command: { executable: command.executable, args: command.args, cwd: jobDir },
      installationFingerprint: `python-${digest({ lock: prepared.lock, python: prepared.pythonVersion, revision: source.revision, platform: REMOTE_PLATFORM }).slice(0, 32)}`,
    };
    return { exitCode: execution.cancelled ? 130 : execution.exitCode, runtime: report };
  };
}
