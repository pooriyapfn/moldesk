export type {
  AssetSpec,
  CommandSpec,
  HardwareRequirements,
  InputSpec,
  ModelCategory,
  ModelManifestV1,
  ModelStatus,
  OutputSpec,
  PlatformId,
  PythonRuntimeSpec,
  DockerRuntimeSpec,
  RequirementLevel,
  RuntimeKind,
  RuntimeSpec,
} from "./schema.js";

/** Legacy v0 manifest shape (pre-validation). Kept for error messaging only. */
export interface LegacyModelManifest {
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  homepage?: string;
  license?: string;
  compatibility?: {
    cpu?: boolean;
    gpu?: "required" | "recommended" | "unsupported";
  };
}
