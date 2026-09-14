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
  uvToolDir,
} from "./filesystem/index.js";
export type { MoldeskPaths } from "./filesystem/index.js";
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
