export interface InstallContext {
  manifestName: string;
  modelDir: string;
  assetsDir: string;
  runner?: import("@moldesk/runtime").InstallCommandRunner;
}

export interface RunContext {
  manifestName: string;
  inputPath: string;
  outputDir: string;
  modelDir: string;
  assetsDir: string;
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
  validateInput(inputPath: string): Promise<void>;
  installPlan(context: InstallContext): Promise<InstallPlan>;
  command(context: RunContext): Promise<import("@moldesk/registry").CommandSpec>;
  collectOutputs(context: RunContext): Promise<CollectedOutput[]>;
  verifyInstallation(context: InstallContext): Promise<VerificationResult>;
}

export { adapterCatalog, getAdapter, hasAdapter, validateAdapterCatalog } from "./catalog.js";
