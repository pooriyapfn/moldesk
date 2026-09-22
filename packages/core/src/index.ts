export {
  collectSystemReport,
  getSystemReport,
  isImageCachedLocally,
  pullDockerImage,
  probeDockerGpuAccess,
} from "@moldesk/runtime";
export type {
  DiskInfo,
  DockerCapability,
  NvidiaCapability,
  NvidiaGpu,
  SystemReport,
  SystemReportDeps,
  ToolCapability,
} from "@moldesk/runtime";
export { listAvailableModels } from "@moldesk/registry";
export type {
  AssetSpec,
  CommandSpec,
  HardwareRequirements,
  InputSpec,
  ModelManifestV1,
  ModelStatus,
  OutputSpec,
  RuntimeKind,
  RuntimeSpec,
} from "@moldesk/registry";
export { MoldeskError } from "./errors.js";
export type { MoldeskErrorData } from "./errors.js";
export { evaluateCompatibility, shortReason } from "./compatibility.js";
export type {
  CompatibilityOptions,
  CompatibilityReason,
  CompatibilityResult,
  CompatibilityStatus,
  RuntimeCompatibility,
} from "./compatibility.js";
export {
  listInstalledModels,
} from "./install-state.js";
export type { InstalledModel } from "./install-state.js";
export {
  createInstallationPlan,
  installModel,
  INSTALL_CONFIRMATION_DISK_BYTES,
  INSTALL_CONFIRMATION_DOWNLOAD_BYTES,
  requiresInstallConfirmation,
  runtimeFingerprint,
  uninstallModel,
} from "./installation.js";
export type {
  InstallationPlanResult,
  InstallCostEstimate,
  InstallModelOptions,
  InstallModelResult,
  UninstallModelOptions,
} from "./installation.js";
export { runModel } from "./run.js";
export type { RunModelOptions, RunModelResult, RunRecord } from "./run.js";

export { VERSION } from "./version.js";
