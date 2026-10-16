import { getHardwareInfo, type HardwareInfo } from "./hardware/index.js";
import { detectPython, type PythonInfo } from "./python/index.js";
import { detectDocker, type DockerInfo } from "./docker/index.js";
import { detectNvidia } from "./nvidia/index.js";
import {
  collectSystemReport,
  type DockerCapability,
  type DiskInfo,
  type NvidiaCapability,
  type NvidiaGpu,
  type SystemReport,
  type SystemReportDeps,
  type ToolCapability,
} from "./system.js";

export interface LegacySystemReport {
  hardware: HardwareInfo;
  python: PythonInfo;
  docker: DockerInfo;
}

/**
 * Canonical system report (spec Step 2 shape). Re-exported through
 * `@moldesk/core` for CLI + future consumers. Accepts `deps.dockerGpuAccess`
 * so `install.ts` can inject a verified Tier-2 Docker GPU probe result.
 */
export async function getSystemReport(deps: SystemReportDeps = {}): Promise<SystemReport> {
  return collectSystemReport(deps);
}

export {
  getMoldeskHome,
  getMoldeskPaths,
  modelInstallDir,
  modelVersionDir,
  pythonToolDir,
  runDir,
  uvToolDir,
  visualizationDir,
  isWithinRoot,
  stageCompanionInputs,
  resolveCompanionInputSources,
} from "./filesystem/index.js";
export type { MoldeskPaths, CompanionInputRef, ResolvedCompanionInputSource, StageCompanionInputsParams, StagedCompanionInputPath } from "./filesystem/index.js";
export type {
  ExecuteRequest,
  ExecutionResult,
  MoldeskErrorData,
  PrepareRuntimeRequest,
  PreparedRuntime,
  RemoveRuntimeRequest,
  RuntimeCapability,
  RuntimeProvider,
} from "./providers.js";
export { MoldeskError } from "./providers.js";
export { PythonRuntimeProvider } from "./providers/python.js";
export { redactEnv } from "./redact.js";
export { CPU_PREP_TYPE_IDS, CPU_POD_MAX_CONTAINER_DISK_GB } from "./cloud/types.js";
export { RunpodProvider, RUNPOD_API_BASE, RUNPOD_USER_AGENT } from "./cloud/runpod.js";
export {
  CredentialStore,
  KEYRING_SERVICE,
  DEFAULT_ACCOUNT_REF,
  PROVIDER_ENV_VARS,
  createKeyringBackend,
  credentialFingerprint,
  redactSecrets,
  validateSecretShape,
} from "./cloud/credentials.js";
export type { CredentialSource, CredentialStoreOptions, ResolvedCredential, SecretBackend } from "./cloud/credentials.js";
export type { RunpodProviderOptions } from "./cloud/runpod.js";
export type * from "./cloud/types.js";
export { EXECUTION_CONTRACT_VERSION, WORKER_PORT, toWireJob } from "./cloud/execution.js";
export {
  RunpodExecutionBackend,
  WORKER_BOOTSTRAP_SCRIPT,
  MIN_WORKER_READY_TIMEOUT_MS,
  VOLUME_MOUNT,
  createKeyringTokenStore,
} from "./cloud/runpod-backend.js";
export type { RunpodBackendOptions, TokenStore, WorkerBundle } from "./cloud/runpod-backend.js";
export { WorkerClient, WORKER_USER_AGENT, isSafeRelativePath, validateInventory } from "./cloud/worker-client.js";
export type { WorkerClientOptions } from "./cloud/worker-client.js";
export type * from "./cloud/execution.js";
export { getHardwareInfo, getDiskInfo } from "./hardware/index.js";
export { detectPython } from "./python/index.js";
export {
  detectDocker,
  isImageCachedLocally,
  pullDockerImage,
  probeDockerGpuAccess,
} from "./docker/index.js";
export { detectNvidia } from "./nvidia/index.js";
export { collectSystemReport } from "./system.js";
export { runCommand } from "./process/index.js";
export { openInBrowser } from "./process/open.js";
export type { OpenResult } from "./process/open.js";
export type { RunOptions, RunResult } from "./process/index.js";
export {
  cacheAsset,
  ensureManagedUv,
  managedUvDownloadBytes,
  materializeAsset,
  prepareDockerImage,
  preparePythonEnvironment,
  temporaryInstallDir,
  MANAGED_UV_VERSION,
} from "./install/index.js";
export type {
  AssetFetch,
  InstallCommandRunner,
  InstallProgress,
  PostInstallHookResult,
  PreparedPythonEnvironment,
  PythonInstallRequest,
} from "./install/index.js";
export type {
  DiskInfo,
  DockerCapability,
  DockerInfo,
  HardwareInfo,
  NvidiaCapability,
  NvidiaGpu,
  PythonInfo,
  SystemReport,
  SystemReportDeps,
  ToolCapability,
};
