export { getSystemReport } from "@moldesk/runtime";
export type { SystemReport } from "@moldesk/runtime";
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
export type { CompatibilityReason, CompatibilityResult, CompatibilityStatus } from "./compatibility.js";

export const VERSION = "0.0.1";
