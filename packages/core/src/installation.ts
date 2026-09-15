import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getAdapter, type InstallPlan } from "@moldesk/adapters";
import {
  cacheAsset,
  getMoldeskPaths,
  materializeAsset,
  managedUvDownloadBytes,
  modelInstallDir,
  prepareDockerImage,
  preparePythonEnvironment,
  resolvePythonLock,
  temporaryInstallDir,
  type InstallCommandRunner,
  type InstallProgress,
  type AssetFetch,
  type MoldeskPaths,
  type ResolvedPythonLock,
} from "@moldesk/runtime";
import type { ModelManifestV1, RuntimeSpec } from "@moldesk/registry";
import { MoldeskError } from "./errors.js";
import { digest } from "./hash.js";
import {
  listInstalledModels,
  rebuildInstallState,
  writeInstallState,
  readInstallState,
  type InstalledModel,
} from "./install-state.js";

export interface InstallationPlanResult {
  readonly manifest: ModelManifestV1;
  readonly runtime: RuntimeSpec;
  readonly runtimeFingerprint: string;
  readonly targetDir: string;
  readonly plan: InstallPlan;
  readonly alreadyInstalled: boolean;
  readonly estimatedDownloadBytes: number;
  readonly estimatedDiskBytes: number;
  /** True when some contributor to the download estimate (an asset or the runtime
   * itself) declares no size, e.g. a Python dependency resolution whose transfer
   * size can't be known ahead of running `uv pip install`. An unknown size must be
   * treated as cost-worthy, not as zero. */
  readonly downloadSizeUnknown: boolean;
  /** Same as {@link downloadSizeUnknown}, for additional disk usage. */
  readonly diskSizeUnknown: boolean;
  /**
   * For a python runtime, the fully resolved transitive dependency lock
   * computed at plan time — its digest is folded into `runtimeFingerprint`
   * so two installs that would resolve differently (e.g. a manifest
   * requirement with an open version range) never silently land at the
   * same install path. Installation installs from this exact lock.
   */
  readonly pythonLock?: ResolvedPythonLock;
}

export interface CreateInstallationPlanOptions {
  runner?: InstallCommandRunner;
  uvExecutable?: string;
  fetch?: AssetFetch;
}

export interface InstallModelOptions {
  paths?: MoldeskPaths;
  reinstall?: boolean;
  runner?: InstallCommandRunner;
  fetch?: AssetFetch;
  uvExecutable?: string;
  onProgress?: (progress: InstallProgress) => void;
}

export interface InstallModelResult {
  status: "installed" | "already-installed" | "reinstalled";
  installation: InstalledModel;
}

export interface UninstallModelOptions {
  paths?: MoldeskPaths;
  runtime?: RuntimeSpec["kind"];
  all?: boolean;
}

export function runtimeFingerprint(runtime: RuntimeSpec, options: { lockDigest?: string } = {}): string {
  return `${runtime.kind}-${digest({
    runtime,
    platform: process.platform,
    architecture: process.arch,
    ...(options.lockDigest ? { lockDigest: options.lockDigest } : {}),
  })}`;
}

function environmentFingerprint(data: unknown): string {
  return digest(data);
}

/** v0.1 defaults per the implementation spec: prompt at >= 1 GiB download or >= 5 GiB
 * additional disk. Kept as constants so the policy can change without touching adapters. */
export const INSTALL_CONFIRMATION_DOWNLOAD_BYTES = 1 * 1024 ** 3;
export const INSTALL_CONFIRMATION_DISK_BYTES = 5 * 1024 ** 3;

export interface InstallCostEstimate {
  downloadBytes: number;
  downloadSizeUnknown: boolean;
  diskBytes: number;
  diskSizeUnknown: boolean;
}

/**
 * Centralized, cost-aware install confirmation policy. An unknown size (as opposed
 * to a size known to be zero) always requires confirmation, since it cannot be shown
 * to be small. A destructive replacement (--reinstall of an existing installation)
 * always requires confirmation regardless of size.
 */
export function requiresInstallConfirmation(
  cost: InstallCostEstimate,
  options: { destructive?: boolean } = {},
): boolean {
  if (options.destructive) return true;
  if (cost.downloadSizeUnknown || cost.diskSizeUnknown) return true;
  return cost.downloadBytes >= INSTALL_CONFIRMATION_DOWNLOAD_BYTES || cost.diskBytes >= INSTALL_CONFIRMATION_DISK_BYTES;
}

function installFailure(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

async function withModelLock<T>(paths: MoldeskPaths, key: string, operation: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(key)) {
    throw installFailure("UNSAFE_MODEL_ID", `Unsafe installation lock key: ${JSON.stringify(key)}.`, "Use a lowercase model id from `moldesk list`.");
  }
  fs.mkdirSync(paths.locks, { recursive: true });
  const lock = path.join(paths.locks, `${key}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as { pid?: unknown; startedAt?: unknown };
        if (typeof owner.startedAt === "string" && Date.now() - Date.parse(owner.startedAt) > 24 * 60 * 60_000) stale = true;
        if (typeof owner.pid === "number") {
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            stale ||= (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        stale = true;
      }
      if (stale && attempt === 0) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      throw installFailure("INSTALL_LOCKED", `Another operation is already changing ${key}.`, "Wait for it to finish, then retry.", { lock });
    }
  }
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    return await operation();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export async function createInstallationPlan(
  manifest: ModelManifestV1,
  runtime: RuntimeSpec,
  paths: MoldeskPaths = getMoldeskPaths(),
  options: CreateInstallationPlanOptions = {},
): Promise<InstallationPlanResult> {
  const adapter = getAdapter(manifest.name);
  if (!adapter) {
    throw installFailure("ADAPTER_NOT_FOUND", `No installation adapter is registered for ${manifest.name}.`, "Choose an installable model from `moldesk list`.");
  }
  if (!manifest.source) {
    throw installFailure("SOURCE_PROVENANCE_MISSING", `${manifest.name} has no pinned source provenance.`, "The registry entry must include a repository and immutable revision.");
  }
  const pythonLock = runtime.kind === "python"
    ? await resolvePythonLock(runtime, { runner: options.runner, uvExecutable: options.uvExecutable, fetch: options.fetch, paths })
    : undefined;
  const fingerprint = runtimeFingerprint(runtime, { lockDigest: pythonLock?.digest });
  const targetDir = modelInstallDir(manifest.name, manifest.modelVersion, fingerprint, { MOLDESK_HOME: paths.home });
  const adapterPlan = await adapter.installPlan({ manifestName: manifest.name, modelDir: targetDir, assetsDir: path.join(targetDir, "assets") });
  const plan = Object.freeze({ steps: Object.freeze([...adapterPlan.steps]) });

  const assets = manifest.assets ?? [];
  const assetDownloadBytes = assets.reduce((sum, asset) => sum + (asset.sizeBytes ?? 0), 0);
  const assetSizeUnknown = assets.some((asset) => asset.sizeBytes === undefined);
  // A Python runtime's estimatedDownloadBytes/estimatedDiskBytes describe dependency
  // resolution cost that can't be known ahead of running `uv pip install`; treat an
  // undeclared estimate as unknown rather than silently rounding it to zero.
  const runtimeDownloadUnknown = runtime.estimatedDownloadBytes === undefined;
  const runtimeDiskUnknown = runtime.estimatedDiskBytes === undefined;

  return Object.freeze({
    manifest,
    runtime,
    runtimeFingerprint: fingerprint,
    targetDir,
    plan,
    alreadyInstalled: listInstalledModels(paths).some((record) => record.installDir === targetDir),
    estimatedDownloadBytes: assetDownloadBytes + (runtime.estimatedDownloadBytes ?? 0) +
      (runtime.kind === "python" ? managedUvDownloadBytes(paths) : 0),
    estimatedDiskBytes: runtime.estimatedDiskBytes ?? 0,
    downloadSizeUnknown: assetSizeUnknown || runtimeDownloadUnknown,
    diskSizeUnknown: runtimeDiskUnknown,
    ...(pythonLock ? { pythonLock } : {}),
  });
}

export async function installModel(
  planned: InstallationPlanResult,
  options: InstallModelOptions = {},
): Promise<InstallModelResult> {
  const paths = options.paths ?? getMoldeskPaths();
  const { manifest, runtime, runtimeFingerprint: fingerprint, targetDir } = planned;
  const key = `${manifest.name}-${manifest.modelVersion}-${fingerprint}`;
  return withModelLock(paths, key, async () => {
    const adapter = getAdapter(manifest.name);
    if (!adapter || !manifest.source) throw installFailure("ADAPTER_NOT_FOUND", `Cannot install ${manifest.name}.`, "Repair the registry installation.");
    const existing = listInstalledModels(paths).find((record) => record.installDir === targetDir);
    if (existing && !options.reinstall) {
      const verification = await adapter.verifyInstallation({ manifestName: manifest.name, modelDir: targetDir, assetsDir: path.join(targetDir, "assets"), runner: options.runner });
      if (verification.passed) return { status: "already-installed", installation: existing };
      throw installFailure("INSTALLATION_DAMAGED", `${manifest.name} is installed but verification failed: ${verification.output ?? "unknown reason"}.`, `Run \`moldesk install ${manifest.name} --reinstall --yes\`.`);
    }

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    const staging = temporaryInstallDir(targetDir);
    const backup = `${targetDir}.backup-${randomUUID()}`;
    let promoted = false;
    let backedUp = false;
    try {
      let dependencyLock: string[] = [];
      let runtimeVersion = "";
      if (runtime.kind === "python") {
        const prepared = await preparePythonEnvironment({
          targetDir: staging,
          repository: manifest.source.repository,
          revision: manifest.source.revision,
          runtime,
          lock: planned.pythonLock?.lock,
          runner: options.runner,
          fetch: options.fetch,
          paths,
          uvExecutable: options.uvExecutable,
          onProgress: options.onProgress,
        });
        dependencyLock = prepared.lock;
        runtimeVersion = prepared.pythonVersion;
      } else {
        const prepared = await prepareDockerImage(runtime, options.runner);
        dependencyLock = [prepared.image];
        runtimeVersion = prepared.digest;
      }

      fs.mkdirSync(path.join(staging, "assets"), { recursive: true });
      for (const asset of manifest.assets ?? []) {
        const object = await cacheAsset(asset, paths, { fetch: options.fetch, onProgress: options.onProgress });
        await materializeAsset(asset, object, path.join(staging, "assets"));
      }

      options.onProgress?.({ step: "verify", message: "Verifying installation" });
      const verification = await adapter.verifyInstallation({ manifestName: manifest.name, modelDir: staging, assetsDir: path.join(staging, "assets"), runner: options.runner });
      if (!verification.passed) {
        throw installFailure("INSTALL_VERIFICATION_FAILED", `Verification failed for ${manifest.name}: ${verification.output ?? "unknown reason"}.`, "Review logs and retry with --reinstall.");
      }

      const now = new Date().toISOString();
      const record: InstalledModel = {
        schemaVersion: 1,
        installationId: randomUUID(),
        model: manifest.name,
        displayName: manifest.displayName,
        modelVersion: manifest.modelVersion,
        adapterVersion: manifest.adapterVersion,
        runtime: {
          kind: runtime.kind,
          fingerprint,
          ...(runtime.kind === "python" ? {
            python: {
              version: runtimeVersion,
              executable: path.join(targetDir, ".venv", "bin", "python"),
              lockSha256: digest(dependencyLock),
            },
          } : { docker: { image: runtime.image, digest: runtime.digest } }),
        },
        environmentFingerprint: environmentFingerprint({
          runtime,
          runtimeVersion,
          dependencyLock,
          sourceRevision: manifest.source.revision,
          platform: process.platform,
          architecture: process.arch,
          release: os.release(),
        }),
        installDir: targetDir,
        source: manifest.source,
        assets: (manifest.assets ?? []).map((asset) => ({
          id: asset.id,
          path: path.join(targetDir, "assets", asset.target),
          sha256: asset.sha256.toLowerCase(),
          sizeBytes: asset.sizeBytes ?? 0,
        })),
        manifestSha256: digest(manifest),
        verification: { passed: true, ...(verification.output ? { output: verification.output } : {}) },
        dependencyLock,
        installedAt: existing?.installedAt ?? now,
        verifiedAt: now,
        status: "ready",
      };
      fs.writeFileSync(path.join(staging, "installation.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      if (fs.existsSync(targetDir)) {
        fs.renameSync(targetDir, backup);
        backedUp = true;
      }
      fs.renameSync(staging, targetDir);
      promoted = true;
      rebuildInstallState(paths);
      if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
      return { status: existing ? "reinstalled" : "installed", installation: record };
    } catch (error) {
      if (promoted) fs.rmSync(targetDir, { recursive: true, force: true });
      if (backedUp && fs.existsSync(backup)) fs.renameSync(backup, targetDir);
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function uninstallModel(modelName: string, options: UninstallModelOptions = {}): Promise<InstalledModel[]> {
  const paths = options.paths ?? getMoldeskPaths();
  return withModelLock(paths, modelName, async () => {
    const allRecords = readInstallState(paths).installations.filter((record) => record.model === modelName);
    const records = options.runtime ? allRecords.filter((record) => record.runtime.kind === options.runtime) : allRecords;
    if (records.length === 0) return [];
    if (!options.runtime && !options.all && records.length > 1) {
      throw installFailure(
        "RUNTIME_SELECTION_REQUIRED",
        `${modelName} has ${records.length} installed runtime variants.`,
        `Pass --runtime python|docker to remove one variant, or --all to remove all variants.`,
      );
    }
    const moved: Array<{ from: string; to: string }> = [];
    const priorState = readInstallState(paths);
    try {
      for (const record of records) {
        const expected = modelInstallDir(record.model, record.modelVersion, record.runtime.fingerprint, { MOLDESK_HOME: paths.home });
        if (fs.existsSync(expected)) {
          const trash = `${expected}.removing-${randomUUID()}`;
          fs.renameSync(expected, trash);
          moved.push({ from: expected, to: trash });
        }
      }
      rebuildInstallState(paths);
      for (const item of moved) fs.rmSync(item.to, { recursive: true, force: true });
      return records;
    } catch (error) {
      for (const item of moved.reverse()) if (fs.existsSync(item.to)) fs.renameSync(item.to, item.from);
      writeInstallState(priorState, paths);
      throw error;
    }
  });
}
