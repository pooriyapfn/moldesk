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
export { listInstalledModels, listAvailableModels } from "@moldesk/registry";
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

export const VERSION = "0.0.1";
