export interface InstallContext {
  manifestName: string;
  modelDir: string;
  assetsDir: string;
  runner?: import("@moldesk/runtime").InstallCommandRunner;
}

export interface RunContext {
  manifestName: string;
  /** Absolute path to the copied input inside the run directory, never the user's original path. */
  inputPath: string;
  /** The run directory's `output/` subdir. `collectOutputs` must only look here. */
  outputDir: string;
  modelDir: string;
  assetsDir: string;
  /** Normalized, validated, defaulted params (see `ParamDescriptor`/`validateParams`). */
  params: Record<string, unknown>;
  /** Resolved runtime executable (e.g. the managed venv's `python`) for this run. */
  runtimeExecutable: string;
}

export interface ParamDescriptor {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  enum?: Array<string | number>;
  description?: string;
}

export interface InstallPlanStep {
  readonly id: string;
  readonly description: string;
}

export interface InstallPlan {
  readonly steps: readonly InstallPlanStep[];
}

export interface CollectedOutput {
  id: string;
  path: string;
}

export interface VerificationResult {
  passed: boolean;
  output?: string;
}

export interface ModelAdapterDefinition {
  readonly modelName: string;
  /** Params this model accepts via `--param key=value`; empty/omitted if none. */
  readonly params?: ParamDescriptor[];
  validateInput(inputPath: string): Promise<void>;
  installPlan(context: InstallContext): Promise<InstallPlan>;
  command(context: RunContext): Promise<import("@moldesk/registry").CommandSpec>;
  collectOutputs(context: RunContext): Promise<CollectedOutput[]>;
  verifyInstallation(context: InstallContext): Promise<VerificationResult>;
}

export { adapterCatalog, getAdapter, hasAdapter, validateAdapterCatalog } from "./catalog.js";
export { validateParams, type ParamValidationResult } from "./params.js";
